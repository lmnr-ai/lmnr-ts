import * as fs from 'fs';
import ts from 'typescript';

import { RolloutParam } from '../../types';

export interface FunctionMetadata {
  name: string;          // The span name from observe({ name: '...' })
  exportName: string;    // The actual export/variable name
  params: RolloutParam[];
}

/**
 * Extracts TypeScript type information as a string
 */
function typeToString(
  typeNode: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
): string | undefined {
  if (!typeNode) return undefined;
  return typeNode.getText(sourceFile);
}

/**
 * Checks if a parameter is optional
 */
function isParameterOptional(param: ts.ParameterDeclaration): boolean {
  // Has ? token
  if (param.questionToken) return true;
  // Has initializer (default value)
  if (param.initializer) return true;
  return false;
}

/**
 * Gets the default value as a string if it exists
 */
function getDefaultValue(
  param: ts.ParameterDeclaration,
  sourceFile: ts.SourceFile,
): string | undefined {
  if (!param.initializer) return undefined;
  return param.initializer.getText(sourceFile);
}

/**
 * Extracts properties from a TypeLiteral node (object type)
 */
function parseTypeLiteral(
  typeLiteral: ts.TypeLiteralNode,
  sourceFile: ts.SourceFile,
): RolloutParam[] {
  const nested: RolloutParam[] = [];

  for (const member of typeLiteral.members) {
    if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
      const propName = member.name.text;
      const propType = member.type ? typeToString(member.type, sourceFile) : undefined;
      const propRequired = !member.questionToken;

      nested.push({
        name: propName,
        type: propType,
        required: propRequired,
      });
    }
  }

  return nested;
}

/**
 * Parses object binding pattern (destructuring) parameters
 */
function parseObjectBinding(
  binding: ts.ObjectBindingPattern,
  typeNode: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
): RolloutParam[] {
  const nested: RolloutParam[] = [];

  // Try to extract type information for each property
  let typeLiteral: ts.TypeLiteralNode | undefined;
  if (typeNode && ts.isTypeLiteralNode(typeNode)) {
    typeLiteral = typeNode;
  }

  for (const element of binding.elements) {
    if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
      const propName = element.name.text;

      // Find corresponding type in the type literal
      let propType: string | undefined;
      let propRequired = true;

      if (typeLiteral) {
        const member = typeLiteral.members.find(
          (m): m is ts.PropertySignature =>
            ts.isPropertySignature(m) &&
            ts.isIdentifier(m.name) &&
            m.name.text === propName,
        );

        if (member) {
          propType = member.type ? typeToString(member.type, sourceFile) : undefined;
          propRequired = !member.questionToken;
        }
      }

      // Check for default value in destructuring
      const defaultValue = element.initializer
        ? element.initializer.getText(sourceFile)
        : undefined;

      nested.push({
        name: propName,
        type: propType,
        required: propRequired && !defaultValue,
        default: defaultValue,
      });
    }
  }

  return nested;
}

/**
 * Parses a single parameter declaration
 */
function parseParameter(
  param: ts.ParameterDeclaration,
  sourceFile: ts.SourceFile,
): RolloutParam | null {
  // Handle simple identifier parameters
  if (ts.isIdentifier(param.name)) {
    const baseParam: RolloutParam = {
      name: param.name.text,
      type: typeToString(param.type, sourceFile),
      required: !isParameterOptional(param),
      default: getDefaultValue(param, sourceFile),
    };

    // If the type is an object literal, extract its properties as nested
    if (param.type && ts.isTypeLiteralNode(param.type)) {
      baseParam.nested = parseTypeLiteral(param.type, sourceFile);
    }

    return baseParam;
  }

  // Handle object destructuring
  if (ts.isObjectBindingPattern(param.name)) {
    const nested = parseObjectBinding(param.name, param.type, sourceFile);

    // Return a synthetic parameter representing the destructured object
    return {
      name: '_destructured', // Special marker for destructured params
      type: typeToString(param.type, sourceFile),
      required: !isParameterOptional(param),
      nested,
    };
  }

  // Handle array destructuring (less common, but for completeness)
  if (ts.isArrayBindingPattern(param.name)) {
    return {
      name: '_arrayDestructured',
      type: typeToString(param.type, sourceFile),
      required: !isParameterOptional(param),
    };
  }

  return null;
}

/**
 * Checks if a call expression is observe() with rolloutEntrypoint: true
 * Also extracts the span name if provided
 */
function isRolloutObserveCall(node: ts.CallExpression): { isRollout: boolean; spanName?: string } {
  // Check if it's a call to 'observe'
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'observe') {
    return { isRollout: false };
  }

  let hasRolloutEntrypoint = false;
  let spanName: string | undefined;

  // Check if it has an options argument with rolloutEntrypoint: true
  if (node.arguments.length > 0) {
    const firstArg = node.arguments[0];
    if (ts.isObjectLiteralExpression(firstArg)) {
      for (const prop of firstArg.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
          // Check for rolloutEntrypoint: true
          if (
            prop.name.text === 'rolloutEntrypoint' &&
            prop.initializer.kind === ts.SyntaxKind.TrueKeyword
          ) {
            hasRolloutEntrypoint = true;
          }
          // Extract span name
          if (prop.name.text === 'name' && ts.isStringLiteral(prop.initializer)) {
            spanName = prop.initializer.text;
          }
        }
      }
    }
  }

  return { isRollout: hasRolloutEntrypoint, spanName };
}

/**
 * Extracts function parameters from a function-like node
 */
function extractFunctionParams(
  func: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
): RolloutParam[] {
  const params: RolloutParam[] = [];

  for (const param of func.parameters) {
    const parsed = parseParameter(param, sourceFile);
    if (parsed) {
      params.push(parsed);
    }
  }

  return params;
}

/**
 * Main function to extract rollout function metadata from a TypeScript file
 */
export function extractRolloutFunctions(filePath: string): Map<string, FunctionMetadata> {
  const result = new Map<string, FunctionMetadata>();

  // Read the source file
  const sourceCode = fs.readFileSync(filePath, 'utf-8');

  // Create a source file
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceCode,
    ts.ScriptTarget.Latest,
    true,
  );

  // First pass: collect all exported identifiers
  const exportedNames = new Set<string>();

  function collectExports(node: ts.Node) {
    // Handle inline exports: export const foo = ...
    if (ts.isVariableStatement(node)) {
      const exportModifier = node.modifiers?.some(
        m => m.kind === ts.SyntaxKind.ExportKeyword,
      );

      if (exportModifier) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            exportedNames.add(declaration.name.text);
          }
        }
      }
    }

    // Handle export declarations: export { foo, bar }
    if (ts.isExportDeclaration(node) && node.exportClause) {
      if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          exportedNames.add(element.name.text);
        }
      }
    }

    ts.forEachChild(node, collectExports);
  }

  collectExports(sourceFile);

  // Second pass: find rollout functions
  function visit(node: ts.Node) {
    // Check for const/var with observe() wrapping
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isVariableDeclaration(declaration) &&
          ts.isIdentifier(declaration.name) &&
          declaration.initializer
        ) {
          const varName = declaration.name.text;

          // Only process if this variable is exported
          if (!exportedNames.has(varName)) {
            continue;
          }

          let funcNode: ts.FunctionLikeDeclaration | undefined;

          // Check for observe(options, func) pattern
          if (ts.isCallExpression(declaration.initializer)) {
            const callExpr = declaration.initializer;

            // Check if it's a direct call to observe with rolloutEntrypoint: true
            const observeInfo = isRolloutObserveCall(callExpr);
            if (observeInfo.isRollout) {
              // The second argument should be the function
              if (callExpr.arguments.length >= 2) {
                let funcArg = callExpr.arguments[1];

                // Unwrap parenthesized expressions
                while (ts.isParenthesizedExpression(funcArg)) {
                  funcArg = funcArg.expression;
                }

                if (ts.isFunctionExpression(funcArg) || ts.isArrowFunction(funcArg)) {
                  funcNode = funcArg;
                }
              }

              if (funcNode) {
                const params = extractFunctionParams(funcNode, sourceFile);
                const spanName = observeInfo.spanName || varName;

                result.set(varName, {
                  name: spanName,        // The span name from observe({ name: '...' })
                  exportName: varName,   // The actual variable/export name
                  params,
                });
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return result;
}

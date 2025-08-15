#!/bin/bash

# Script to generate recorder.ts from the minified recorder script
# Usage: ./generate-recorder-from-minjs.sh

set -e

# Paths
MINIFIED_FILE="../../assets/recorder/record.umd.min.cjs"
OUTPUT_FILE="recorder.ts"

# Check if the minified file exists
if [ ! -f "$MINIFIED_FILE" ]; then
    echo "Error: Minified file not found at $MINIFIED_FILE"
    exit 1
fi

echo "Generating recorder.ts from $MINIFIED_FILE..."

# Read the minified content and apply the required replacements
MINIFIED_CONTENT=$(cat "$MINIFIED_FILE")

# Apply replacements for regular template literal:
# 1. Replace \ with \\ (must be first!)
# 2. Replace ` with \`
# 3. Replace ${ with \${
ESCAPED_CONTENT=$(echo "$MINIFIED_CONTENT" | sed 's/\\/\\\\/g' | sed 's/`/\\`/g' | sed 's/\${/\\${/g')

# Generate the output file
cat > "$OUTPUT_FILE" << EOF
// generated using generate-recorder-from-minjs.sh
export const RECORDER = \`$ESCAPED_CONTENT\`;
EOF

echo "Successfully generated $OUTPUT_FILE"
echo "File size: $(wc -c < "$OUTPUT_FILE") bytes"

import { WORKER_MESSAGE_PREFIX, WorkerConfig, WorkerMessage } from '@lmnr-ai/types';
import { ChildProcess, spawn } from 'child_process';
import * as readline from 'readline';

import { initializeLogger } from '../utils';

const logger = initializeLogger();

export interface ExecuteOptions {
  command: string;
  args: string[];
  config: WorkerConfig;
}

/**
 * Track and kill the currently running subprocess
 */
export class SubprocessManager {
  private currentProcess: ChildProcess | null = null;

  /**
   * Execute a subprocess and track it
   */
  async execute(options: ExecuteOptions): Promise<any> {
    const { command, args, config } = options;

    // Spawn the worker process
    const child: ChildProcess = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.currentProcess = child;

    return new Promise((resolve, reject) => {
      let result: any = undefined;
      let hasError = false;

      // Set up readline interface for stdout
      const rl = readline.createInterface({
        input: child.stdout!,
        crlfDelay: Infinity,
      });

      // Handle messages from worker
      rl.on('line', (line: string) => {
        // Check if this is a worker protocol message or user output
        if (line.startsWith(WORKER_MESSAGE_PREFIX)) {
          // Parse worker protocol message
          try {
            const messageJson = line.substring(WORKER_MESSAGE_PREFIX.length);
            const message: WorkerMessage = JSON.parse(messageJson);

            switch (message.type) {
              // wrapped in a block for const not to be hoisted
              case 'log': {
                // Forward log messages through pino logger
                logger[message.level](message.message);
                break;
              }
              case 'result':
                result = message.data;
                break;

              case 'error':
                hasError = true;
                logger.error(`Worker error: ${message.error}`);
                if (message.stack) {
                  logger.error(message.stack);
                }
                break;
            }
          } catch {
            logger.debug(`Failed to parse worker protocol message. Printing raw line: ${line}`);
            console.log(line.substring(WORKER_MESSAGE_PREFIX.length));
          }
        } else {
          // This is user output from console.log - pass it through transparently
          console.log(line);
        }
      });

      // Pass through stderr for user's console.error
      child.stderr!.on('data', (data: Buffer) => {
        process.stderr.write(data);
      });

      // Handle process exit
      child.on('exit', (code: number | null, signal: string | null) => {
        if (this.currentProcess?.pid === child.pid) {
          this.currentProcess = null;
        }

        if (signal) {
          reject(new Error(`Worker terminated by signal: ${signal}`));
        } else if (code === 0) {
          resolve(result);
        } else {
          if (!hasError) {
            logger.error(`Worker exited with code ${code}`);
          }
          reject(new Error(`Worker exited with code ${code}`));
        }
      });

      // Handle spawn errors
      child.on('error', (error: Error) => {
        this.currentProcess = null;
        reject(new Error(`Failed to spawn worker: ${error.message}`));
      });

      // Send configuration to worker via stdin
      child.stdin?.write(JSON.stringify(config) + '\n');
      child.stdin?.end();
    });
  }

  /**
   * Kill the currently running subprocess
   * @returns true if a process was killed, false if no process was running
   */
  kill(): boolean {
    if (this.currentProcess) {
      const processToKill = this.currentProcess;
      this.currentProcess.kill('SIGTERM');

      // Fallback to SIGKILL after 5 seconds
      setTimeout(() => {
        // exitCode is null if the process is still running
        if (processToKill && processToKill.exitCode === null) {
          logger.warn('Child process did not terminate, using SIGKILL');
          processToKill.kill('SIGKILL');
        }
      }, 5000);
      return true;
    }
    return false;
  }

  /**
   * Check if a subprocess is currently running
   */
  isRunning(): boolean {
    return this.currentProcess !== null;
  }
}

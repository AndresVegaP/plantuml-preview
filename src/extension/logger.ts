/**
 * Logging.
 *
 * Everything the extension wants to tell a developer goes through here and
 * lands in a `LogOutputChannel`, which gives users the standard "Set Log Level"
 * control instead of a bespoke verbosity setting to discover.
 *
 * Nothing here ever leaves the machine: there is no telemetry in this
 * extension, and the output channel is the only sink.
 */

import * as vscode from 'vscode';

import type { IDisposable } from '../shared/disposable.js';

export interface Logger {
  trace(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, error?: unknown): void;
  show(): void;
}

export class OutputChannelLogger implements Logger, IDisposable {
  private readonly channel: vscode.LogOutputChannel;

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  trace(message: string, ...args: unknown[]): void {
    this.channel.trace(message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.channel.info(message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.channel.warn(message, ...args);
  }

  error(message: string, error?: unknown): void {
    if (error === undefined) {
      this.channel.error(message);
      return;
    }
    // A non-Error value is described rather than stringified, so an object does
    // not reach the log as "[object Object]".
    this.channel.error(message, error instanceof Error ? error : describeError(error));
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}

/** Turns an unknown thrown value into a message safe to show a user. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

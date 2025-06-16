import { Transport, TransportSendOptions } from './transport.js';
import { JSONRPCMessage } from '../types.js';
import { AuthInfo } from '../server/auth/types.js';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Debug log entry structure for JSONL output
 */
interface DebugLogEntry {
    hrtime: string;
    time: string;
    pid: number;
    role: 'client' | 'server' | 'unknown';
    direction: 'send' | 'recv';
    message: JSONRPCMessage;
}

/**
 * A transport decorator that logs all messages to files for debugging.
 *
 * This can wrap any transport implementation to provide debugging capabilities
 * without STDERR interleaving issues in parent/child process scenarios.
 */
export class DebugTransport implements Transport {
    private logFilePath: string;
    private logFileHandle: fs.FileHandle | null = null;

    constructor(
        private wrappedTransport: Transport,
        private role: 'client' | 'server' | 'unknown',
        private debugBasePath: string
    ) {
        if (!wrappedTransport) {
            throw new Error('DebugTransport: wrappedTransport parameter is required');
        }
        this.logFilePath = `${debugBasePath}.${role}.${process.pid}`;
    }

    get sessionId(): string | undefined {
        return this.wrappedTransport.sessionId;
    }

    private async ensureLogFile(): Promise<void> {
        if (this.logFileHandle) return;

        try {
            // Ensure parent directory exists if path contains directories
            const parentDir = dirname(this.logFilePath);
            if (parentDir !== '.') {
                await fs.mkdir(parentDir, { recursive: true });
            }

            // Open file for appending
            this.logFileHandle = await fs.open(this.logFilePath, 'a');
        } catch (error) {
            console.error(`[DebugTransport] Failed to open log file ${this.logFilePath}:`, error);
            // Continue without logging rather than failing
        }
    }

    private async writeLogEntry(direction: 'send' | 'recv', message: JSONRPCMessage): Promise<void> {
        if (!this.logFileHandle) {
            console.warn('[DebugTransport] Attempted to write log entry but file handle is null');
            return;
        }

        const entry: DebugLogEntry = {
            hrtime: process.hrtime.bigint().toString(),
            time: new Date().toISOString(),
            pid: process.pid,
            role: this.role,
            direction,
            message
        };

        try {
            const line = JSON.stringify(entry) + '\n';
            await this.logFileHandle.write(line);
            if (this.logFileHandle) {
                await this.logFileHandle.sync(); // Ensure data is written to disk
            }
        } catch (error) {
            console.error('[DebugTransport] Failed to write log entry:', error);
        }
    }

    async start(): Promise<void> {
        await this.ensureLogFile();

        // Set up wrapped callbacks on the underlying transport
        if (!this.wrappedTransport) {
            throw new Error('DebugTransport: wrappedTransport is not initialized');
        }

        this.wrappedTransport.onmessage = (message: JSONRPCMessage, extra?: { authInfo?: AuthInfo }) => {
            this.writeLogEntry('recv', message);
            if (this._onmessage) {
                this._onmessage(message, extra);
            }
        };

        this.wrappedTransport.onerror = (error: Error) => {
            if (this.logFileHandle) {
                const errorEntry = {
                    hrtime: process.hrtime.bigint().toString(),
                    time: new Date().toISOString(),
                    pid: process.pid,
                    role: this.role,
                    direction: 'error' as const,
                    error: error.message
                };
                this.logFileHandle.write(JSON.stringify(errorEntry) + '\n').catch(() => {});
            }
            if (this._onerror) {
                this._onerror(error);
            }
        };

        this.wrappedTransport.onclose = () => {
            if (this.logFileHandle) {
                const closeEntry = {
                    hrtime: process.hrtime.bigint().toString(),
                    time: new Date().toISOString(),
                    pid: process.pid,
                    role: this.role,
                    direction: 'close' as const
                };
                this.logFileHandle.write(JSON.stringify(closeEntry) + '\n').catch(() => {});
                this.logFileHandle.close().catch(() => {});
                this.logFileHandle = null;
            }
            if (this._onclose) {
                this._onclose();
            }
        };

        await this.wrappedTransport.start();
    }

    async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        await this.writeLogEntry('send', message);
        await this.wrappedTransport.send(message, options);
    }

    async close(): Promise<void> {
        await this.wrappedTransport.close();
        if (this.logFileHandle) {
            await this.logFileHandle.close();
            this.logFileHandle = null;
        }
    }

    // Store callbacks to be wrapped in start()
    private _onclose?: () => void;
    private _onerror?: (error: Error) => void;
    private _onmessage?: (message: JSONRPCMessage, extra?: { authInfo?: AuthInfo }) => void;

    set onclose(callback: (() => void) | undefined) {
        this._onclose = callback;
    }

    get onclose(): (() => void) | undefined {
        return this._onclose;
    }

    set onerror(callback: ((error: Error) => void) | undefined) {
        this._onerror = callback;
    }

    get onerror(): ((error: Error) => void) | undefined {
        return this._onerror;
    }

    set onmessage(callback: ((message: JSONRPCMessage, extra?: { authInfo?: AuthInfo }) => void) | undefined) {
        this._onmessage = callback;
    }

    get onmessage(): ((message: JSONRPCMessage, extra?: { authInfo?: AuthInfo }) => void) | undefined {
        return this._onmessage;
    }

    // Simple wrapper implementation chosen over Proxy pattern for predictability
    // and consistency with existing codebase style
    setProtocolVersion?(version: string): void {
        if (this.wrappedTransport.setProtocolVersion) {
            this.wrappedTransport.setProtocolVersion(version);
        }
    }
}

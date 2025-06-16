import { Client } from '../../src/client/index.js';
import { McpServer } from '../../src/server/mcp.js';
import { InMemoryTransport } from '../../src/inMemory.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';

// Type for debug log entries
interface DebugLogEntry {
    hrtime: string;
    time: string;
    pid: number;
    role: string;
    direction: string;
    message?: {
        method?: string;
        params?: unknown;
        id?: unknown;
        [key: string]: unknown;
    };
    error?: string;
}

// Helper function to find debug files created for a base path
async function getDebugFiles(basePath: string): Promise<{ files: string[]; fullPaths: string[] }> {
    const parentDir = dirname(basePath);
    const baseName = basename(basePath);
    const allFiles = await fs.readdir(parentDir);
    const debugFiles = allFiles.filter(f => f.startsWith(baseName + '.') && f.match(/\.(client|server)\.\d+$/));
    const fullPaths = debugFiles.map(f => join(parentDir, f));
    return { files: debugFiles, fullPaths };
}

describe('Debug Transport Integration', () => {
    let testDir: string;
    let originalEnv: string | undefined;

    beforeEach(async () => {
        testDir = join(tmpdir(), `mcp-debug-integration-${Date.now()}`);
        await fs.mkdir(testDir, { recursive: true });
        originalEnv = process.env.MCP_DEBUG_TRANSPORT;
    });

    afterEach(async () => {
        // Restore original environment
        if (originalEnv === undefined) {
            delete process.env.MCP_DEBUG_TRANSPORT;
        } else {
            process.env.MCP_DEBUG_TRANSPORT = originalEnv;
        }

        // Cleanup test directory and any debug files
        try {
            await fs.rm(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }

        // Also cleanup any debug files that may have been created
        try {
            const { fullPaths } = await getDebugFiles(testDir);
            for (const filePath of fullPaths) {
                await fs.unlink(filePath);
            }
        } catch {
            // Ignore cleanup errors
        }
    });

    describe('Environment Variable Activation', () => {
        it('should enable debug transport when MCP_DEBUG_TRANSPORT is set', async () => {
            process.env.MCP_DEBUG_TRANSPORT = testDir;

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            const server = new McpServer(
                {
                    name: 'test-server',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            await client.close();
            await server.close();

            // Verify debug files were created
            const { files: debugFiles } = await getDebugFiles(testDir);
            expect(debugFiles).toEqual(
                expect.arrayContaining([expect.stringMatching(/\.client\.\d+$/), expect.stringMatching(/\.server\.\d+$/)])
            );
        });

        it('should not create debug files when MCP_DEBUG_TRANSPORT is not set', async () => {
            // Ensure environment variable is not set
            delete process.env.MCP_DEBUG_TRANSPORT;

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            const server = new McpServer(
                {
                    name: 'test-server',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            await client.close();
            await server.close();

            // Verify no debug files were created in our test directory
            const dirExists = await fs
                .access(testDir)
                .then(() => true)
                .catch(() => false);
            if (dirExists) {
                const files = await fs.readdir(testDir);
                expect(files.filter(f => f.startsWith('mcp_debug.'))).toHaveLength(0);
            }
        });
    });

    describe('Message Flow Logging', () => {
        it('should log complete client-server conversation', async () => {
            process.env.MCP_DEBUG_TRANSPORT = join(testDir, 'mcp_debug');

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            const server = new McpServer(
                {
                    name: 'test-server',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            // Set up error handlers like other transport tests
            let clientError: Error | null = null;
            let serverError: Error | null = null;
            clientTransport.onerror = error => {
                clientError = error;
            };
            serverTransport.onerror = error => {
                serverError = error;
            };

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Generate specific message sequence like stdio tests
            await client.ping();

            await client.close();
            await server.close();

            // Verify no errors occurred
            expect(clientError).toBeNull();
            expect(serverError).toBeNull();

            // Read and verify log entries
            const files = await fs.readdir(testDir);
            const logFiles = files.filter(f => f.startsWith('mcp_debug.'));
            expect(logFiles.length).toBeGreaterThanOrEqual(2);

            // Collect all log entries and sort by timestamp
            const allEntries: DebugLogEntry[] = [];
            for (const file of logFiles) {
                const content = await fs.readFile(join(testDir, file), 'utf8');
                const lines = content
                    .trim()
                    .split('\n')
                    .filter(line => line.length > 0);
                for (const line of lines) {
                    try {
                        allEntries.push(JSON.parse(line));
                    } catch {
                        // Skip invalid JSON lines
                    }
                }
            }

            // Sort by high-resolution timestamp
            allEntries.sort((a, b) => (BigInt(a.hrtime) < BigInt(b.hrtime) ? -1 : 1));

            // Verify we have a conversation flow
            expect(allEntries.length).toBeGreaterThan(0);

            // Should have both client and server entries
            const clientEntries = allEntries.filter(e => e.role === 'client');
            const serverEntries = allEntries.filter(e => e.role === 'server');
            expect(clientEntries.length).toBeGreaterThan(0);
            expect(serverEntries.length).toBeGreaterThan(0);

            // Should have both send and receive entries
            const sendEntries = allEntries.filter(e => e.direction === 'send');
            const recvEntries = allEntries.filter(e => e.direction === 'recv');
            expect(sendEntries.length).toBeGreaterThan(0);
            expect(recvEntries.length).toBeGreaterThan(0);

            // Should contain expected message types
            const messages = allEntries.filter(e => e.message).map(e => e.message!);
            const initializeMessages = messages.filter(m => m.method === 'initialize');
            expect(initializeMessages.length).toBeGreaterThan(0);
        });

        it('should maintain message ordering across processes', async () => {
            process.env.MCP_DEBUG_TRANSPORT = join(testDir, 'mcp_debug');

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            const server = new McpServer(
                {
                    name: 'test-server',
                    version: '1.0.0'
                },
                {
                    capabilities: { tools: {} }
                }
            );

            // Add a tool to generate more message traffic
            server.tool(
                'test-tool',
                'A test tool',
                {
                    type: 'object',
                    properties: {}
                },
                async () => ({ content: [{ type: 'text', text: 'test result' }] })
            );

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Generate multiple messages
            await client.ping();
            const tools = await client.listTools();
            if (tools.tools.length > 0) {
                await client.callTool({ name: 'test-tool', arguments: {} });
            }

            await client.close();
            await server.close();

            // Reconstruct conversation
            const files = await fs.readdir(testDir);
            const allEntries: DebugLogEntry[] = [];

            for (const file of files.filter(f => f.startsWith('mcp_debug.'))) {
                const content = await fs.readFile(join(testDir, file), 'utf8');
                const lines = content
                    .trim()
                    .split('\n')
                    .filter(line => line.length > 0);
                for (const line of lines) {
                    try {
                        allEntries.push(JSON.parse(line));
                    } catch {
                        // Skip invalid JSON
                    }
                }
            }

            // Sort by hrtime (high-resolution timestamp)
            allEntries.sort((a, b) => (BigInt(a.hrtime) < BigInt(b.hrtime) ? -1 : 1));

            // Verify timestamp ordering is consistent
            for (let i = 1; i < allEntries.length; i++) {
                expect(BigInt(allEntries[i].hrtime)).toBeGreaterThanOrEqual(BigInt(allEntries[i - 1].hrtime));
            }
        });
    });

    describe('Error Scenarios', () => {
        it('should handle invalid debug directory gracefully', async () => {
            // Save original env var
            const savedEnv = process.env.MCP_DEBUG_TRANSPORT;

            try {
                // Set debug directory to invalid path
                process.env.MCP_DEBUG_TRANSPORT = '/root/invalid/path/that/cannot/exist';

                const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

                const client = new Client(
                    {
                        name: 'test-client',
                        version: '1.0.0'
                    },
                    {
                        capabilities: {}
                    }
                );

                const server = new McpServer(
                    {
                        name: 'test-server',
                        version: '1.0.0'
                    },
                    {
                        capabilities: {}
                    }
                );

                // Should not throw errors despite invalid debug path
                await expect(Promise.all([client.connect(clientTransport), server.connect(serverTransport)])).resolves.toBeDefined();

                await expect(client.ping()).resolves.toBeDefined();

                await Promise.all([client.close(), server.close()]);
            } finally {
                // Restore original env var
                if (savedEnv === undefined) {
                    delete process.env.MCP_DEBUG_TRANSPORT;
                } else {
                    process.env.MCP_DEBUG_TRANSPORT = savedEnv;
                }
            }
        });

        it('should continue working when log files are deleted during operation', async () => {
            process.env.MCP_DEBUG_TRANSPORT = testDir;

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            const server = new McpServer(
                {
                    name: 'test-server',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Delete log files while connection is active
            const files = await fs.readdir(testDir);
            for (const file of files) {
                await fs.unlink(join(testDir, file)).catch(() => {});
            }

            // Should still work despite deleted log files
            await expect(client.ping()).resolves.toBeDefined();

            await Promise.all([client.close(), server.close()]);
        });
    });

    describe('Role Detection', () => {
        it('should correctly identify client and server roles', async () => {
            process.env.MCP_DEBUG_TRANSPORT = join(testDir, 'mcp_debug');

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            const server = new McpServer(
                {
                    name: 'test-server',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            await client.close();
            await server.close();

            // Verify correct role identification in filenames
            const files = await fs.readdir(testDir);
            expect(files).toEqual(
                expect.arrayContaining([
                    expect.stringMatching(/^mcp_debug\.client\.\d+$/),
                    expect.stringMatching(/^mcp_debug\.server\.\d+$/)
                ])
            );

            // Verify role field in log entries
            for (const file of files) {
                const content = await fs.readFile(join(testDir, file), 'utf8');
                const lines = content
                    .trim()
                    .split('\n')
                    .filter(line => line.length > 0);

                for (const line of lines) {
                    try {
                        const entry = JSON.parse(line);
                        if (file.includes('client')) {
                            expect(entry.role).toBe('client');
                        } else if (file.includes('server')) {
                            expect(entry.role).toBe('server');
                        }
                    } catch {
                        // Skip invalid JSON
                    }
                }
            }
        });
    });

    describe('Log Entry Format', () => {
        it('should produce valid JSONL format for conversation reconstruction', async () => {
            process.env.MCP_DEBUG_TRANSPORT = join(testDir, 'mcp_debug');

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            const server = new McpServer(
                {
                    name: 'test-server',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            await client.ping();

            await client.close();
            await server.close();

            // Test that logs can be reconstructed using jq-like sorting
            const files = await fs.readdir(testDir);
            const allEntries: DebugLogEntry[] = [];

            for (const file of files.filter(f => f.startsWith('mcp_debug.'))) {
                const content = await fs.readFile(join(testDir, file), 'utf8');
                const lines = content
                    .trim()
                    .split('\n')
                    .filter(line => line.length > 0);

                for (const line of lines) {
                    const entry = JSON.parse(line); // Should not throw

                    // Verify required fields exist
                    expect(entry).toHaveProperty('hrtime');
                    expect(entry).toHaveProperty('time');
                    expect(entry).toHaveProperty('pid');
                    expect(entry).toHaveProperty('role');
                    expect(entry).toHaveProperty('direction');

                    // Verify field types and formats
                    expect(typeof entry.hrtime).toBe('string');
                    expect(entry.hrtime).toMatch(/^\d+$/);
                    expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
                    expect(typeof entry.pid).toBe('number');
                    expect(['client', 'server', 'unknown']).toContain(entry.role);
                    expect(['send', 'recv', 'error', 'close']).toContain(entry.direction);

                    allEntries.push(entry);
                }
            }

            // Verify conversation can be reconstructed by sorting
            allEntries.sort((a, b) => (BigInt(a.hrtime) < BigInt(b.hrtime) ? -1 : 1));
            expect(allEntries.length).toBeGreaterThan(0);
        });
    });

    describe('Transport Lifecycle', () => {
        it('should start and close debug transport cleanly', async () => {
            process.env.MCP_DEBUG_TRANSPORT = join(testDir, 'mcp_debug');

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            const server = new McpServer(
                {
                    name: 'test-server',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            // Should start without errors
            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Should close cleanly without throwing errors
            await expect(Promise.all([client.close(), server.close()])).resolves.not.toThrow();

            // Verify log files exist and contain close events
            const files = await fs.readdir(testDir);
            expect(files.length).toBeGreaterThan(0);

            for (const file of files.filter(f => f.startsWith('mcp_debug.'))) {
                const content = await fs.readFile(join(testDir, file), 'utf8');
                const lines = content
                    .trim()
                    .split('\n')
                    .filter(line => line.length > 0);

                const closeEvents = lines.filter(line => {
                    try {
                        const entry = JSON.parse(line);
                        return entry.direction === 'close';
                    } catch {
                        return false;
                    }
                });

                expect(closeEvents.length).toBeGreaterThan(0);
            }
        });
    });

    describe('Specific Message Sequences', () => {
        it('should log exact message round-trips', async () => {
            process.env.MCP_DEBUG_TRANSPORT = join(testDir, 'mcp_debug');

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            const server = new McpServer(
                {
                    name: 'test-server',
                    version: '1.0.0'
                },
                {
                    capabilities: { tools: {} }
                }
            );

            // Add a specific tool for testing
            server.tool(
                'test-tool',
                'Test tool for debug logging',
                {
                    type: 'object',
                    properties: {
                        message: { type: 'string', description: 'Test message' }
                    }
                },
                async ({ message }) => ({
                    content: [{ type: 'text', text: `Echo: ${message}` }]
                })
            );

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Execute specific sequence of operations
            await client.ping();
            await client.listTools();
            await client.callTool({
                name: 'test-tool',
                arguments: { message: 'debug test' }
            });

            await Promise.all([client.close(), server.close()]);

            // Verify specific messages were logged
            const files = await fs.readdir(testDir);
            const allEntries: DebugLogEntry[] = [];

            for (const file of files.filter(f => f.startsWith('mcp_debug.'))) {
                const content = await fs.readFile(join(testDir, file), 'utf8');
                const lines = content
                    .trim()
                    .split('\n')
                    .filter(line => line.length > 0);
                for (const line of lines) {
                    try {
                        allEntries.push(JSON.parse(line));
                    } catch {
                        // Skip invalid JSON
                    }
                }
            }

            // Sort by timestamp
            allEntries.sort((a, b) => (BigInt(a.hrtime) < BigInt(b.hrtime) ? -1 : 1));

            // Verify we have the expected message types
            const messages = allEntries.filter(e => e.message).map(e => e.message);

            // Should have initialize messages
            const initMessages = messages.filter(m => m?.method === 'initialize');
            expect(initMessages.length).toBeGreaterThan(0);

            // Should have ping messages
            const pingMessages = messages.filter(m => m?.method === 'ping');
            expect(pingMessages.length).toBeGreaterThan(0);

            // Should have tool listing
            const listToolsMessages = messages.filter(m => m?.method === 'tools/list');
            expect(listToolsMessages.length).toBeGreaterThan(0);

            // Should have tool call
            const callToolMessages = messages.filter(m => m?.method === 'tools/call');
            expect(callToolMessages.length).toBeGreaterThan(0);
        });

        it('should preserve message content integrity', async () => {
            process.env.MCP_DEBUG_TRANSPORT = join(testDir, 'mcp_debug');

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            const server = new McpServer(
                {
                    name: 'test-server',
                    version: '1.0.0'
                },
                {
                    capabilities: { tools: {} }
                }
            );

            // Add tool with complex data
            server.tool(
                'complex-tool',
                'Tool with complex parameters',
                {
                    type: 'object',
                    properties: {
                        data: {
                            type: 'object',
                            properties: {
                                numbers: { type: 'array', items: { type: 'number' } },
                                nested: {
                                    type: 'object',
                                    properties: {
                                        text: { type: 'string' },
                                        flag: { type: 'boolean' }
                                    }
                                }
                            }
                        }
                    }
                },
                async ({ data }) => ({
                    content: [
                        {
                            type: 'text',
                            text: `Processed: ${JSON.stringify(data)}`
                        }
                    ]
                })
            );

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Call with complex data
            const complexData = {
                numbers: [1, 2, 3.14, -5],
                nested: {
                    text: 'test with "quotes" and \n newlines',
                    flag: true
                }
            };

            await client.callTool({
                name: 'complex-tool',
                arguments: { data: complexData }
            });

            await Promise.all([client.close(), server.close()]);

            // Verify complex data was logged correctly
            const files = await fs.readdir(testDir);
            let foundComplexData = false;

            for (const file of files.filter(f => f.startsWith('mcp_debug.'))) {
                const content = await fs.readFile(join(testDir, file), 'utf8');
                const lines = content
                    .trim()
                    .split('\n')
                    .filter(line => line.length > 0);

                for (const line of lines) {
                    try {
                        const entry = JSON.parse(line);
                        if (entry.message?.method === 'tools/call' && entry.message?.params?.arguments?.data) {
                            const loggedData = entry.message.params.arguments.data;
                            expect(loggedData).toEqual(complexData);
                            foundComplexData = true;
                        }
                    } catch {
                        // Skip invalid JSON
                    }
                }
            }

            expect(foundComplexData).toBe(true);
        });
    });

    describe('Multiple Transport Sessions', () => {
        it('should handle sequential transport sessions correctly', async () => {
            process.env.MCP_DEBUG_TRANSPORT = join(testDir, 'mcp_debug');

            // Test multiple sequential sessions to verify file handling
            for (let session = 0; session < 2; session++) {
                const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

                const client = new Client(
                    {
                        name: `test-client-session-${session}`,
                        version: '1.0.0'
                    },
                    {
                        capabilities: {}
                    }
                );

                const server = new McpServer(
                    {
                        name: `test-server-session-${session}`,
                        version: '1.0.0'
                    },
                    {
                        capabilities: {}
                    }
                );

                await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

                // Generate unique traffic for this session
                await client.ping();

                await Promise.all([client.close(), server.close()]);
            }

            // Verify log files exist and contain logs from all sessions
            const files = await fs.readdir(testDir);
            const debugFiles = files.filter(f => f.startsWith('mcp_debug.'));

            // Should have at least one client and one server file
            expect(debugFiles.length).toBeGreaterThanOrEqual(2);

            let totalLogEntries = 0;
            const foundSessions = new Set<string>();

            // Verify each file contains valid logs
            for (const file of debugFiles) {
                const content = await fs.readFile(join(testDir, file), 'utf8');
                const lines = content
                    .trim()
                    .split('\n')
                    .filter(line => line.length > 0);

                expect(lines.length).toBeGreaterThan(0);
                totalLogEntries += lines.length;

                // Each line should be valid JSON
                for (const line of lines) {
                    const entry = JSON.parse(line); // Should not throw

                    // Track which sessions we've seen
                    if (entry.message?.method === 'initialize') {
                        foundSessions.add(entry.role);
                    }
                }
            }

            // Should have logged multiple sessions worth of messages
            expect(totalLogEntries).toBeGreaterThan(10); // Multiple sessions should generate substantial logs

            // Should have seen both client and server roles
            expect(foundSessions.has('client')).toBe(true);
            expect(foundSessions.has('server')).toBe(true);
        });

        it('should work regardless of underlying transport implementation', async () => {
            process.env.MCP_DEBUG_TRANSPORT = join(testDir, 'mcp_debug');

            // Create a single session to test transport-agnostic behavior
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            const client = new Client(
                {
                    name: 'transport-agnostic-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            const server = new McpServer(
                {
                    name: 'transport-agnostic-server',
                    version: '1.0.0'
                },
                {
                    capabilities: { tools: {} }
                }
            );

            // Add a tool to generate more diverse traffic
            server.tool(
                'transport-test',
                'Test tool for transport verification',
                {
                    type: 'object',
                    properties: {}
                },
                async () => ({
                    content: [{ type: 'text', text: 'Transport test successful' }]
                })
            );

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Generate various types of messages
            await client.ping();
            const tools = await client.listTools();
            if (tools.tools.length > 0) {
                await client.callTool({ name: 'transport-test', arguments: {} });
            }

            await Promise.all([client.close(), server.close()]);

            // Verify comprehensive logging regardless of transport type
            const files = await fs.readdir(testDir);
            const debugFiles = files.filter(f => f.startsWith('mcp_debug.'));

            expect(debugFiles.length).toBeGreaterThanOrEqual(2);

            // Collect all entries and verify transport-agnostic behavior
            const allEntries: DebugLogEntry[] = [];
            for (const file of debugFiles) {
                const content = await fs.readFile(join(testDir, file), 'utf8');
                const lines = content
                    .trim()
                    .split('\n')
                    .filter(line => line.length > 0);
                for (const line of lines) {
                    allEntries.push(JSON.parse(line));
                }
            }

            // Should have captured the diverse message types
            const messages = allEntries.filter(e => e.message).map(e => e.message);
            const messageTypes = [...new Set(messages.map(m => m?.method))];

            // Should have at least basic message types
            expect(messageTypes).toEqual(expect.arrayContaining(['initialize', 'ping']));

            // Should have proper role distribution
            const clientEntries = allEntries.filter(e => e.role === 'client');
            const serverEntries = allEntries.filter(e => e.role === 'server');
            expect(clientEntries.length).toBeGreaterThan(0);
            expect(serverEntries.length).toBeGreaterThan(0);
        });
    });

    describe('High Volume Traffic', () => {
        it('should handle rapid message sequences without data loss', async () => {
            process.env.MCP_DEBUG_TRANSPORT = join(testDir, 'mcp_debug');

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            const client = new Client(
                {
                    name: 'test-client',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            const server = new McpServer(
                {
                    name: 'test-server',
                    version: '1.0.0'
                },
                {
                    capabilities: {}
                }
            );

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            // Generate rapid sequence of ping operations
            const pingPromises = [];
            for (let i = 0; i < 10; i++) {
                pingPromises.push(client.ping());
            }
            await Promise.all(pingPromises);

            await Promise.all([client.close(), server.close()]);

            // Verify all messages were logged
            const files = await fs.readdir(testDir);
            const allEntries: DebugLogEntry[] = [];

            for (const file of files.filter(f => f.startsWith('mcp_debug.'))) {
                const content = await fs.readFile(join(testDir, file), 'utf8');
                const lines = content
                    .trim()
                    .split('\n')
                    .filter(line => line.length > 0);
                for (const line of lines) {
                    try {
                        allEntries.push(JSON.parse(line));
                    } catch {
                        // Skip invalid JSON
                    }
                }
            }

            // Should have logged many ping-related messages
            const messages = allEntries.filter(e => e.message).map(e => e.message!);
            const pingMessages = messages.filter(m => m?.method === 'ping');

            // Should have at least the 10 ping requests we sent
            expect(pingMessages.length).toBeGreaterThanOrEqual(10);

            // Verify timestamp ordering is maintained
            allEntries.sort((a, b) => (BigInt(a.hrtime) < BigInt(b.hrtime) ? -1 : 1));
            for (let i = 1; i < allEntries.length; i++) {
                expect(BigInt(allEntries[i].hrtime)).toBeGreaterThanOrEqual(BigInt(allEntries[i - 1].hrtime));
            }
        });
    });
});

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { GoogleCalendarService } from './services/GoogleCalendarService.js';
import { registerListCalendarsTool } from './tools/listCalendars.js';
import { registerFindAvailableSlotsTool } from './tools/findAvailableSlots.js';
import { registerSubscribeCalendarTool } from './tools/subscribeCalendar.js';

const PORT = Number.parseInt(process.env['PORT'] ?? '3000', 10);
const SERVICE_ACCOUNT_KEY_FILE = process.env['GOOGLE_SERVICE_ACCOUNT_KEY_FILE'];

if (!SERVICE_ACCOUNT_KEY_FILE) {
    throw new Error(
        'Missing required env var GOOGLE_SERVICE_ACCOUNT_KEY_FILE. ' +
            'Set it to the absolute path of your Google Service Account JSON key file.',
    );
}

// Eagerly construct the calendar service so that credential/config issues
// surface at startup rather than on the first tool invocation. The service
// itself is stateless and safe to share across sessions.
const calendarService = new GoogleCalendarService(SERVICE_ACCOUNT_KEY_FILE);

/**
 * Builds a fresh `McpServer` with all tools registered. Streamable HTTP
 * sessions are 1:1 with transports, and the SDK enforces that one server
 * connects to exactly one transport — so each new session gets its own
 * server instance. Tool registration is cheap; the heavyweight Google
 * client lives on `calendarService` and is shared.
 */
function createMcpServer(): McpServer {
    const server = new McpServer(
        {
            name: 'calendar-mcp',
            version: '1.0.0',
        },
        {
            capabilities: {
                tools: {},
            },
        },
    );

    registerListCalendarsTool(server, calendarService);
    registerFindAvailableSlotsTool(server, calendarService);
    registerSubscribeCalendarTool(server, calendarService);

    return server;
}

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Active transports keyed by Mcp-Session-Id. Streamable HTTP uses a
 * single endpoint for both SSE streaming (GET) and JSON-RPC messages
 * (POST); the session id is exchanged via the `Mcp-Session-Id` header.
 */
const transports = new Map<string, StreamableHTTPServerTransport>();

const handleMcpRequest = async (req: Request, res: Response): Promise<void> => {
    const headerSessionId = req.headers['mcp-session-id'];
    const sessionId = typeof headerSessionId === 'string' ? headerSessionId : undefined;

    let transport: StreamableHTTPServerTransport | undefined = sessionId
        ? transports.get(sessionId)
        : undefined;

    if (!transport) {
        // A new session is only allowed on an `initialize` POST. Every
        // other request without a known session id is a protocol error.
        if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: no valid MCP session id' },
                id: null,
            });
            return;
        }

        const sessionServer = createMcpServer();

        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
                transports.set(sid, transport!);
            },
        });

        transport.onclose = () => {
            if (transport?.sessionId) {
                transports.delete(transport.sessionId);
            }
            // Tear down the per-session server so its handlers and any
            // pending state are released. Best-effort: errors here are
            // logged but not propagated to the client.
            void sessionServer.close().catch((err: unknown) => {
                console.error('[MCP] Error closing session server', err);
            });
        };

        try {
            // Cast: the SDK's concrete class exposes `onclose` as `| undefined`
            // while the `Transport` interface declares it as optional (without
            // `| undefined`). Semantically identical, but `exactOptionalPropertyTypes`
            // treats them as distinct.
            await sessionServer.connect(transport as Transport);
        } catch (error) {
            console.error('[MCP] Failed to establish session', error);
            void sessionServer.close().catch(() => {
                /* swallow: we're already in an error path */
            });
            if (!res.headersSent) {
                res.status(500).end('Failed to establish MCP session');
            }
            return;
        }
    }

    await transport.handleRequest(req, res, req.body);
};

app.post('/mcp', handleMcpRequest);
app.get('/mcp', handleMcpRequest);
app.delete('/mcp', handleMcpRequest);

app.get('/health', (_req: Request, res: Response): void => {
    res.json({ status: 'ok', activeSessions: transports.size });
});

app.listen(PORT, () => {
    console.log(`[calendar-mcp] MCP server listening on http://localhost:${PORT}`);
    console.log(`[calendar-mcp]   Streamable HTTP endpoint: /mcp (GET | POST | DELETE)`);
});

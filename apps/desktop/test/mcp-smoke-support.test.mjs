import { describe, expect, it } from 'vitest';

import {
  EXPECTED_MCP_TOOL_NAMES,
  MCP_V1_CASE_IDS,
  assertDocumentUnchanged,
  assertEvidenceSafe,
  assertExactToolCatalog,
  assertProtocolStdout,
  assertRevisionAdvanced,
  assertSafeDiagnostic,
  assertSafeProjection,
  assertToolError,
  createCaseRecorder,
  createMcpFailureEvidence,
  createMcpEvidence,
  decodeToolResponse,
} from '../scripts/mcp-smoke-support.mjs';

const tool = (name) => ({ name, inputSchema: { type: 'object' } });
const response = (payload, isError = false) => ({
  jsonrpc: '2.0',
  id: 1,
  result: {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  },
});

describe('packaged MCP smoke protocol oracle', () => {
  it('requires the exact V1 tool allowlist with object schemas', () => {
    expect(assertExactToolCatalog(EXPECTED_MCP_TOOL_NAMES.map(tool))).toEqual(
      EXPECTED_MCP_TOOL_NAMES,
    );
    expect(() =>
      assertExactToolCatalog([...EXPECTED_MCP_TOOL_NAMES.map(tool), tool('shell_exec')]),
    ).toThrow(/allowlist/u);
    expect(() =>
      assertExactToolCatalog(
        EXPECTED_MCP_TOOL_NAMES.filter((name) => name !== 'documents_validate').map(tool),
      ),
    ).toThrow(/allowlist/u);
    expect(() =>
      assertExactToolCatalog(EXPECTED_MCP_TOOL_NAMES.map((name) => ({ name, inputSchema: null }))),
    ).toThrow(/object input schema/u);
  });

  it('decodes successful JSON tool results and only approved safe error codes', () => {
    expect(decodeToolResponse(response({ running: true }))).toEqual({
      ok: true,
      value: { running: true },
    });
    const denied = decodeToolResponse(
      response(
        {
          error: {
            code: 'APPROVAL_REQUIRED',
            message: 'Desktop approval is required.',
          },
        },
        true,
      ),
    );
    expect(assertToolError(denied, 'APPROVAL_REQUIRED')).toBe('APPROVAL_REQUIRED');
    expect(() =>
      decodeToolResponse(
        response(
          { error: { code: 'INTERNAL_STACK', message: 'C:\\Users\\Ada\\deck.hdeck' } },
          true,
        ),
      ),
    ).toThrow(/unsafe or malformed/u);
    expect(() => decodeToolResponse(response({ ok: true, extra: 1 }, true))).toThrow(/unsafe/u);
  });

  it('normalizes JSON-RPC schema and unknown-tool failures without exposing messages', () => {
    const outcome = decodeToolResponse({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32602, message: 'Invalid params' },
    });
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'JSON_RPC_ERROR', category: -32602 },
    });
    expect(assertToolError(outcome, 'JSON_RPC_ERROR')).toBe('JSON_RPC_ERROR');
  });

  it('accepts only complete JSON-RPC response lines on stdout', () => {
    const bytes = Buffer.from(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n`,
    );
    expect(assertProtocolStdout(bytes)).toBe(1);
    expect(() => assertProtocolStdout(Buffer.from('warning\n'))).toThrow(/non-JSON/u);
    expect(() =>
      assertProtocolStdout(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{} }')),
    ).toThrow(/incomplete/u);
    expect(() =>
      assertProtocolStdout(
        Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {}, error: {} })}\n`),
      ),
    ).toThrow(/invalid JSON-RPC/u);
  });

  it('rejects unsafe diagnostics and projections', () => {
    expect(assertSafeDiagnostic('HTMLlelujah desktop bridge is unavailable.')).toBe(true);
    expect(() => assertSafeDiagnostic('failed at C:\\Users\\Ada\\deck.hdeck')).toThrow(
      /local path/u,
    );
    expect(() => assertSafeDiagnostic('failed with top-secret', ['top-secret'])).toThrow(
      /endpoint material/u,
    );
    expect(assertSafeProjection({ document: { title: 'Safe' }, slides: [] })).toBe(true);
    expect(() => assertSafeProjection({ filePath: 'deck.hdeck' })).toThrow(/forbidden field/u);
    expect(() => assertSafeProjection({ nested: { html: '<script />' } })).toThrow(
      /forbidden field/u,
    );
  });

  it('checks proposal non-mutation and opaque revision advancement', () => {
    const outline = {
      documentId: 'document',
      revision: 'r1',
      name: 'Deck',
      page: { widthPt: 960, heightPt: 540 },
      slides: [{ id: 'slide', title: 'One' }],
    };
    expect(assertDocumentUnchanged(outline, structuredClone(outline))).toBe(true);
    expect(() => assertDocumentUnchanged(outline, { ...outline, name: 'Changed' })).toThrow(
      /mutated/u,
    );
    expect(assertRevisionAdvanced('r1', 'r2')).toBe(true);
    expect(() => assertRevisionAdvanced('r1', 'r1')).toThrow(/did not advance/u);
  });
});

describe('packaged MCP smoke evidence', () => {
  const completedCases = () => {
    const recorder = createCaseRecorder();
    for (const caseId of MCP_V1_CASE_IDS) {
      recorder.begin(caseId);
      recorder.pass(caseId, [`${caseId} assertion`]);
    }
    return recorder.evidence();
  };

  it('is complete, bounded, and contains no runtime capabilities or local paths', () => {
    const evidence = createMcpEvidence({
      generatedAt: '2026-07-16T12:00:00.000Z',
      mode: 'packaged-launcher',
      platform: 'win32',
      architecture: 'x64',
      version: '1.0.0',
      artifact: { executableSha256: 'a'.repeat(64), launcherSha256: 'b'.repeat(64) },
      cases: completedCases(),
      protocolFrameCount: 42,
      processCount: 7,
      limitations: ['Different-account Windows execution is covered by a dedicated system gate.'],
    });
    expect(evidence.result).toBe('passed');
    expect(evidence.cases.map((entry) => entry.id)).toEqual(MCP_V1_CASE_IDS);
    expect(assertEvidenceSafe(evidence)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain('approval-');
  });

  it('fails closed on an omitted case, failed case, secret key, capability, or path', () => {
    const common = {
      generatedAt: '2026-07-16T12:00:00.000Z',
      mode: 'packaged-launcher',
      platform: 'win32',
      architecture: 'x64',
      version: '1.0.0',
      artifact: {},
      protocolFrameCount: 1,
      processCount: 1,
    };
    expect(() => createMcpEvidence({ ...common, cases: completedCases().slice(1) })).toThrow(
      /every V1 case/u,
    );
    expect(() =>
      createMcpEvidence({
        ...common,
        cases: completedCases().map((entry, index) =>
          index === 0 ? { ...entry, status: 'failed' } : entry,
        ),
      }),
    ).toThrow(/incomplete or failed/u);
    expect(() => assertEvidenceSafe({ secret: 'value' })).toThrow(/forbidden key/u);
    expect(() => assertEvidenceSafe({ note: 'approval-abcdefghijklmnop' })).toThrow(
      /local path or capability/u,
    );
    expect(() => assertEvidenceSafe({ note: 'C:\\Users\\Ada\\deck.hdeck' })).toThrow(
      /local path or capability/u,
    );
  });

  it('refuses to emit evidence until every case is recorded', () => {
    const recorder = createCaseRecorder();
    recorder.begin('MCP-001');
    recorder.pass('MCP-001', ['initialized']);
    expect(() => recorder.evidence()).toThrow(/was not completed/u);
    expect(() => recorder.pass('MCP-002', [])).toThrow(/no assertions/u);
    expect(() => recorder.begin('MCP-999')).toThrow(/Unknown/u);
  });

  it('emits a redacted failure marker without copying the thrown diagnostic', () => {
    expect(
      createMcpFailureEvidence({
        generatedAt: '2026-07-16T12:00:00.000Z',
        mode: 'packaged-launcher',
        platform: 'win32',
        architecture: 'x64',
        stage: 'MCP-006',
      }),
    ).toMatchObject({
      result: 'failed',
      failure: { stage: 'MCP-006', code: 'MCP_SMOKE_FAILED' },
    });
    expect(() =>
      createMcpFailureEvidence({
        generatedAt: '2026-07-16T12:00:00.000Z',
        mode: 'packaged-launcher',
        platform: 'win32',
        architecture: 'x64',
        stage: 'C:\\Users\\Ada\\secret',
      }),
    ).toThrow(/stage was invalid/u);
  });
});

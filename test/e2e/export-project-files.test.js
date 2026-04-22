'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Regression tests for project-level file downloads (Issue #2)
// Verifies that downloadProjectFiles runs even when a project has zero conversations.
describe('project-level file downloads (e2e)', () => {
  let CONFIG, PATHS, initPaths, tmpDir;

  beforeEach(() => {
    jest.resetModules();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-projfiles-'));

    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(process.stdout, 'write').mockImplementation();

    ({ CONFIG, PATHS, initPaths } = require('../../lib/config'));
    CONFIG.outputDir = tmpDir;
    CONFIG.exportFormat = 'both';
    CONFIG.throttleMs = 0;
    CONFIG.includeProjects = true;
    CONFIG.projectsOnly = true;
    CONFIG.downloadFiles = true;
    CONFIG.updateExisting = false;
    CONFIG.showSummary = true;
    CONFIG.maxConversations = null;
    CONFIG.convFilter = null;
    CONFIG.projFilter = null;
    CONFIG.verbose = false;
    initPaths();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (global.fetch?.mockRestore) global.fetch.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockProjectListResponse(projects) {
    return {
      items: projects.map(p => ({
        gizmo: {
          gizmo: {
            id: p.id,
            display: { name: p.name, description: '' },
            instructions: '',
            workspace_id: null,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
            num_interactions: 0,
          },
          files: (p.files || []).map(f => ({
            id: f.id,
            file_id: f.file_id,
            name: f.name,
            type: f.type || 'application/octet-stream',
            size: f.size || 100,
          })),
        },
      })),
      cursor: null,
    };
  }

  function mockFileDownloadResponse(fileId, fileName) {
    return {
      status: 'success',
      download_url: `https://files.example.com/${fileId}`,
      file_name: fileName,
    };
  }

  test('downloads project files when project has zero conversations', async () => {
    const projectData = mockProjectListResponse([{
      id: 'proj-001',
      name: 'Reference Project',
      files: [
        { id: 'file-ref-1', file_id: 'file-ref-1', name: 'notes.txt', type: 'text/plain', size: 42 },
      ],
    }]);

    global.fetch = jest.fn().mockImplementation((url) => {
      // Project list endpoint
      if (url.includes('/gizmos/snorlax/sidebar')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(projectData),
        });
      }
      // Project conversations endpoint — returns empty
      if (url.includes('/gizmos/proj-001/conversations')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ items: [], cursor: null }),
        });
      }
      // File download metadata
      if (url.includes('/files/download/file-ref-1')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(mockFileDownloadResponse('file-ref-1', 'notes.txt')),
        });
      }
      // Actual file binary download
      if (url.includes('files.example.com/file-ref-1')) {
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: () => 'text/plain' },
          arrayBuffer: () => Promise.resolve(Buffer.from('hello world')),
        });
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ items: [] }),
      });
    });

    const { run } = require('../../lib/exporter');
    const summary = await run('fake-token');

    // Project should be counted
    expect(summary.projects.count).toBe(1);
    // No conversations were exported
    expect(summary.projects.conversations).toBe(0);
    // Project file should have been downloaded
    expect(summary.projects.fileCount).toBeGreaterThanOrEqual(1);

    // Verify the file download endpoint was actually called
    const fileDownloadCalls = global.fetch.mock.calls.filter(
      ([u]) => u.includes('/files/download/file-ref-1')
    );
    expect(fileDownloadCalls.length).toBe(1);
  });

  test('downloads project files AND exports conversations when both exist', async () => {
    const projectData = mockProjectListResponse([{
      id: 'proj-002',
      name: 'Full Project',
      files: [
        { id: 'file-full-1', file_id: 'file-full-1', name: 'data.csv', type: 'text/csv', size: 200 },
      ],
    }]);

    const projectConv = {
      id: 'conv-proj-001', title: 'Project Chat',
      create_time: 1700000000, update_time: 1700001000,
    };

    const fullConv = {
      id: 'conv-proj-001', title: 'Project Chat',
      create_time: 1700000000, update_time: 1700001000,
      mapping: {
        root: { parent: null, children: ['m1'], message: null },
        m1: {
          parent: 'root', children: [],
          message: {
            content: { content_type: 'text', parts: ['Hello'] },
            author: { role: 'user' },
            metadata: {},
          },
        },
      },
    };

    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/gizmos/snorlax/sidebar')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(projectData),
        });
      }
      if (url.includes('/gizmos/proj-002/conversations')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ items: [projectConv], cursor: null }),
        });
      }
      if (url.includes('/conversation/conv-proj-001')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(fullConv),
        });
      }
      if (url.includes('/files/download/file-full-1')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(mockFileDownloadResponse('file-full-1', 'data.csv')),
        });
      }
      if (url.includes('files.example.com/file-full-1')) {
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: () => 'text/csv' },
          arrayBuffer: () => Promise.resolve(Buffer.from('a,b,c')),
        });
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ items: [] }),
      });
    });

    const { run } = require('../../lib/exporter');
    const summary = await run('fake-token');

    expect(summary.projects.count).toBe(1);
    // Conversation was exported
    expect(summary.projects.success).toBe(1);
    // File was downloaded
    expect(summary.projects.fileCount).toBeGreaterThanOrEqual(1);

    // Both conversation fetch and file download were called
    const convCalls = global.fetch.mock.calls.filter(
      ([u]) => u.includes('/conversation/conv-proj-001')
    );
    const fileCalls = global.fetch.mock.calls.filter(
      ([u]) => u.includes('/files/download/file-full-1')
    );
    expect(convCalls.length).toBe(1);
    expect(fileCalls.length).toBe(1);
  });

  test('project with no conversations and no files produces zero counts without errors', async () => {
    const projectData = mockProjectListResponse([{
      id: 'proj-003',
      name: 'Empty Project',
      files: [],
    }]);

    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/gizmos/snorlax/sidebar')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(projectData),
        });
      }
      if (url.includes('/gizmos/proj-003/conversations')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ items: [], cursor: null }),
        });
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ items: [] }),
      });
    });

    const { run } = require('../../lib/exporter');
    const summary = await run('fake-token');

    expect(summary.projects.count).toBe(1);
    expect(summary.projects.conversations).toBe(0);
    expect(summary.projects.success).toBe(0);
    expect(summary.projects.error).toBe(0);
    expect(summary.projects.fileCount).toBe(0);
  });

  test('multiple projects: files downloaded for all including those with no conversations', async () => {
    const projectData = mockProjectListResponse([
      {
        id: 'proj-with-convs',
        name: 'Active Project',
        files: [
          { id: 'file-active-1', file_id: 'file-active-1', name: 'active.pdf', type: 'application/pdf', size: 500 },
        ],
      },
      {
        id: 'proj-no-convs',
        name: 'Template Project',
        files: [
          { id: 'file-template-1', file_id: 'file-template-1', name: 'template.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 300 },
        ],
      },
    ]);

    const projectConv = {
      id: 'conv-active-001', title: 'Active Chat',
      create_time: 1700000000, update_time: 1700001000,
    };

    const fullConv = {
      id: 'conv-active-001', title: 'Active Chat',
      create_time: 1700000000, update_time: 1700001000,
      mapping: {
        root: { parent: null, children: ['m1'], message: null },
        m1: {
          parent: 'root', children: [],
          message: {
            content: { content_type: 'text', parts: ['Test'] },
            author: { role: 'user' },
            metadata: {},
          },
        },
      },
    };

    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/gizmos/snorlax/sidebar')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(projectData),
        });
      }
      // Active project has one conversation
      if (url.includes('/gizmos/proj-with-convs/conversations')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ items: [projectConv], cursor: null }),
        });
      }
      // Template project has zero conversations
      if (url.includes('/gizmos/proj-no-convs/conversations')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ items: [], cursor: null }),
        });
      }
      if (url.includes('/conversation/conv-active-001')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(fullConv),
        });
      }
      // File download metadata for both project files
      if (url.includes('/files/download/file-active-1')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(mockFileDownloadResponse('file-active-1', 'active.pdf')),
        });
      }
      if (url.includes('/files/download/file-template-1')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(mockFileDownloadResponse('file-template-1', 'template.docx')),
        });
      }
      // Actual file binary downloads
      if (url.includes('files.example.com/file-active-1')) {
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: () => 'application/pdf' },
          arrayBuffer: () => Promise.resolve(Buffer.from('pdf-content')),
        });
      }
      if (url.includes('files.example.com/file-template-1')) {
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: () => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
          arrayBuffer: () => Promise.resolve(Buffer.from('docx-content')),
        });
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ items: [] }),
      });
    });

    const { run } = require('../../lib/exporter');
    const summary = await run('fake-token');

    expect(summary.projects.count).toBe(2);
    // Only the active project had conversations
    expect(summary.projects.success).toBe(1);

    // Both project files should have been downloaded
    const activeFileCalls = global.fetch.mock.calls.filter(
      ([u]) => u.includes('/files/download/file-active-1')
    );
    const templateFileCalls = global.fetch.mock.calls.filter(
      ([u]) => u.includes('/files/download/file-template-1')
    );
    expect(activeFileCalls.length).toBe(1);
    expect(templateFileCalls.length).toBe(1);
  });

  test('project file download URL uses gizmo_id parameter (not inline=false)', async () => {
    const projectData = mockProjectListResponse([{
      id: 'g-p-abc123',
      name: 'Gizmo Test Project',
      files: [
        { id: 'file-gz-1', file_id: 'file-gz-1', name: 'report.pdf', type: 'application/pdf', size: 1024 },
      ],
    }]);

    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/gizmos/snorlax/sidebar')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(projectData),
        });
      }
      if (url.includes('/gizmos/g-p-abc123/conversations')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ items: [], cursor: null }),
        });
      }
      if (url.includes('/files/download/file-gz-1')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(mockFileDownloadResponse('file-gz-1', 'report.pdf')),
        });
      }
      if (url.includes('files.example.com/file-gz-1')) {
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: () => 'application/pdf' },
          arrayBuffer: () => Promise.resolve(Buffer.from('pdf-bytes')),
        });
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ items: [] }),
      });
    });

    const { run } = require('../../lib/exporter');
    await run('fake-token');

    // Find the metadata fetch call for the project file
    const fileMetaCalls = global.fetch.mock.calls.filter(
      ([u]) => u.includes('/files/download/file-gz-1')
    );
    expect(fileMetaCalls.length).toBe(1);

    const [metaUrl] = fileMetaCalls[0];
    // Must include gizmo_id with the correct project ID
    expect(metaUrl).toContain('gizmo_id=g-p-abc123');
    // Must NOT use the old inline=false parameter
    expect(metaUrl).not.toContain('inline=false');
  });
});

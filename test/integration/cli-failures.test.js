'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const BIN = path.resolve(__dirname, '../../export-chatgpt.js');

function run(args, opts = {}) {
  try {
    const result = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, NODE_ENV: 'test' },
      ...opts,
    });
    return { stdout: result, exitCode: 0 };
  } catch (error) {
    return {
      stdout: (error.stdout || '') + (error.stderr || ''),
      exitCode: error.status ?? 1,
    };
  }
}

describe('CLI failure cases', () => {
  test('exits with error when no auth token provided in non-interactive mode', () => {
    const { stdout, exitCode } = run(['--non-interactive']);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('--non-interactive requires --bearer or --token');
  });

  test('exits with error for invalid bearer token (auth failure)', () => {
    const { stdout, exitCode } = run(['--non-interactive', '--bearer', 'completely-invalid-token']);
    expect(exitCode).not.toBe(0);
  });

  test('invalid --delay shows warning but continues', () => {
    const { stdout } = run(['--bearer', 'fake', '--non-interactive', '--delay', 'abc']);
    expect(stdout).toContain('Invalid --delay');
    expect(stdout).toContain('1500ms');
  });

  test('negative --delay shows warning', () => {
    const { stdout } = run(['--bearer', 'fake', '--non-interactive', '--delay', '-5']);
    expect(stdout).toContain('Invalid --delay');
  });

  test('unknown flags produce error', () => {
    const { stdout, exitCode } = run(['--nonexistent-flag']);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('unknown option');
  });

  test('--projects-only with --no-projects is handled', () => {
    // --projects-only forces includeProjects=true per the code
    const { stdout } = run(['--bearer', 'fake', '--non-interactive', '--projects-only', '--no-projects']);
    // Should proceed with projects-only (--projects-only wins)
    expect(stdout).toContain('projects only');
  });

  test('CHATGPT_BEARER_TOKEN env var is accepted in non-interactive mode', () => {
    const { stdout, exitCode } = run(['--non-interactive'], {
      env: { ...process.env, CHATGPT_BEARER_TOKEN: 'fake-env-token', NODE_ENV: 'test' },
    });
    // Should get past the token validation (will fail on API call)
    expect(stdout).not.toContain('--non-interactive requires --bearer');
  });

  test('CHATGPT_SESSION_TOKEN env var is accepted in non-interactive mode', () => {
    const { stdout, exitCode } = run(['--non-interactive'], {
      env: { ...process.env, CHATGPT_SESSION_TOKEN: 'fake-session', NODE_ENV: 'test' },
    });
    expect(stdout).not.toContain('--non-interactive requires --bearer');
  });

  test('--format with invalid value still runs (no validation currently)', () => {
    const { stdout } = run(['--bearer', 'fake', '--non-interactive', '--format', 'xml']);
    // Should proceed without crashing (format just won't match any case)
    expect(stdout).toContain('ChatGPT Conversation Exporter');
  });
});

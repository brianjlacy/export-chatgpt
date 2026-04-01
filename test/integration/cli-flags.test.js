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

describe('CLI flag parsing', () => {
  test('--help shows usage information', () => {
    const { stdout, exitCode } = run(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('export-chatgpt');
    expect(stdout).toContain('--bearer');
    expect(stdout).toContain('--format');
    expect(stdout).toContain('--delay');
  });

  test('--version shows version number', () => {
    const { stdout, exitCode } = run(['--version']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('--help shows --non-interactive flag', () => {
    const { stdout } = run(['--help']);
    expect(stdout).toContain('--non-interactive');
    expect(stdout).toContain('-n');
  });

  test('--help shows --no-summary flag', () => {
    const { stdout } = run(['--help']);
    expect(stdout).toContain('--no-summary');
  });

  test('--help shows --no-donate flag', () => {
    const { stdout } = run(['--help']);
    expect(stdout).toContain('--no-donate');
  });

  test('--help shows non-interactive example', () => {
    const { stdout } = run(['--help']);
    expect(stdout).toContain('Non-interactive');
  });

  test('--non-interactive without token fails with clear error', () => {
    const { stdout, exitCode } = run(['--non-interactive']);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('--non-interactive requires --bearer or --token');
  });

  test('-n is short for --non-interactive', () => {
    const { stdout, exitCode } = run(['-n']);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('--non-interactive requires --bearer or --token');
  });

  test('--non-interactive with --bearer does not prompt for token', () => {
    // This will fail on auth but should NOT prompt for input
    const { stdout, exitCode } = run(['--non-interactive', '--bearer', 'fake-token']);
    // Should get past the token prompt and fail on actual API call or timeout
    expect(exitCode).not.toBe(0);
    expect(stdout).not.toContain('Enter Bearer token');
  });

  test('--delay validates numeric input', () => {
    const { stdout } = run(['--bearer', 'fake', '--delay', 'notanumber', '--non-interactive']);
    expect(stdout).toContain('Invalid --delay');
  });

  test('all file skip flags are recognized', () => {
    const { stdout } = run(['--help']);
    expect(stdout).toContain('--no-images');
    expect(stdout).toContain('--no-canvas');
    expect(stdout).toContain('--no-attachments');
    expect(stdout).toContain('--no-files');
  });
});

describe('CLI config propagation', () => {
  // These tests verify that CLI flags correctly propagate to CONFIG
  // by checking observable behavior (output messages)

  test('shows "Update mode" when --update is passed', () => {
    const { stdout } = run(['--bearer', 'fake', '--non-interactive', '--update']);
    expect(stdout).toContain('Update mode');
  });

  test('shows project export mode when projects included', () => {
    const { stdout } = run(['--bearer', 'fake', '--non-interactive']);
    expect(stdout).toContain('Project export: included');
  });

  test('shows "projects only" when --projects-only is passed', () => {
    const { stdout } = run(['--bearer', 'fake', '--non-interactive', '--projects-only']);
    expect(stdout).toContain('projects only');
  });

  test('shows file downloads enabled by default', () => {
    const { stdout } = run(['--bearer', 'fake', '--non-interactive']);
    expect(stdout).toContain('File downloads: enabled');
  });

  test('does not show file downloads when --no-files is passed', () => {
    const { stdout } = run(['--bearer', 'fake', '--non-interactive', '--no-files']);
    expect(stdout).not.toContain('File downloads: enabled');
  });
});

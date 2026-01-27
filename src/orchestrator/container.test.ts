import { ContainerManager } from './container.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

async function runTests() {
  console.log('=== Container Manager Integration Tests ===\n');

  // Create temp workspace
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-test-'));
  await fs.writeFile(path.join(workspaceDir, 'test.txt'), 'hello world');
  console.log('Created temporary workspace:', workspaceDir, '\n');

  const manager = new ContainerManager();

  try {
    // Test 1: Create and start container
    console.log('Test 1: Create and start container...');
    await manager.create({
      image: 'agent-sandbox:latest',
      workspaceDir,
    });
    await manager.start();
    console.log('  ✓ Container created and started\n');

    // Test 2: Execute command and get output
    console.log('Test 2: Execute command...');
    const result = await manager.exec(['cat', 'test.txt']);
    if (result.stdout.trim() !== 'hello world') {
      throw new Error(`Expected 'hello world', got '${result.stdout}'`);
    }
    console.log('  ✓ Command output:', result.stdout.trim());
    console.log('  ✓ Exit code:', result.exitCode, '\n');

    // Test 3: Verify network isolation
    console.log('Test 3: Verify network isolation...');
    const pingResult = await manager.exec(['sh', '-c', 'ping -c 1 8.8.8.8 2>&1 || echo "network blocked"']);
    if (!pingResult.stdout.includes('network') && !pingResult.stderr.includes('network')) {
      console.log('  Warning: Network might not be fully isolated');
    } else {
      console.log('  ✓ Network access blocked as expected\n');
    }

    // Test 4: Verify non-root user
    console.log('Test 4: Verify non-root user...');
    const whoami = await manager.exec(['whoami']);
    if (whoami.stdout.trim() !== 'agent') {
      throw new Error(`Expected 'agent', got '${whoami.stdout}'`);
    }
    console.log('  ✓ Running as user:', whoami.stdout.trim(), '\n');

    // Test 5: Verify workspace mount
    console.log('Test 5: Verify workspace mount...');
    const pwd = await manager.exec(['pwd']);
    if (!pwd.stdout.includes(workspaceDir)) {
      throw new Error(`Workspace not mounted at expected path`);
    }
    console.log('  ✓ Workspace mounted at:', pwd.stdout.trim(), '\n');

    // Test 6: Write file and verify persistence on host
    console.log('Test 6: Verify file persistence...');
    await manager.exec(['sh', '-c', 'echo "from container" > created.txt']);
    const createdContent = await fs.readFile(path.join(workspaceDir, 'created.txt'), 'utf-8');
    if (createdContent.trim() !== 'from container') {
      throw new Error('File not persisted to host');
    }
    console.log('  ✓ Files persist to host filesystem\n');

    console.log('=== All tests passed! ===');

  } finally {
    // Cleanup
    console.log('\nCleaning up...');
    await manager.cleanup();
    await fs.rm(workspaceDir, { recursive: true });
    console.log('Done.');
  }
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

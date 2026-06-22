#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  writeUatEvidenceBundle,
  writeUatEvidenceLedger
} from './evidence-bundle.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(REPO_ROOT, 'packages/cli/bin/vibeloop');
const KEEP_TMP = process.env.VIBELOOP_UAT_KEEP_TMP === '1';
const PRUNE = process.env.VIBELOOP_UAT_PRUNE === '1' && !KEEP_TMP;
const RUN_TAG = `repo-matrix-${process.pid}-${Date.now()}`;

function redact(text) {
  return String(text).replace(
    /(Token|Authorization|Bearer)\s+[A-Za-z0-9._~+/=-]+/g,
    '$1 [REDACTED]'
  );
}

function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function yamlSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function javaTool(tool) {
  return process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, 'bin', tool)
    : tool;
}

function javaVisibleCommand() {
  const javac = shSingleQuote(javaTool('javac'));
  const java = shSingleQuote(javaTool('java'));
  return [
    'rm -rf out',
    'mkdir -p out',
    `${javac} -d out src/Cart.java tests/CartQuantityTest.java`,
    `${java} -cp out CartQuantityTest`
  ].join(' && ');
}

function swiftVisibleCommand() {
  return [
    'swiftc -o cart-test Sources/Cart.swift Tests/main.swift',
    './cart-test'
  ].join(' && ');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({
        code: null,
        stdout,
        stderr: error.message,
        spawnError: true
      });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, spawnError: false });
    });
  });
}

async function mustRun(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.code})\nstdout:\n${redact(
        result.stdout
      )}\nstderr:\n${redact(result.stderr)}`
    );
  }
  return result.stdout;
}

async function git(cwd, args) {
  return mustRun('git', args, { cwd });
}

async function commandAvailable(command, args = ['--version']) {
  const result = await runCommand(command, args);
  return result.code === 0;
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
}

async function countFiles(root) {
  let total = 0;
  async function walk(dir) {
    const entries = await import('node:fs/promises').then((fs) =>
      fs.readdir(dir, { withFileTypes: true })
    );
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        total += 1;
      }
    }
  }
  await walk(root);
  return total;
}

function nodeCartFiles() {
  return {
    'src/cart.cjs': [
      'function lineTotal(item) {',
      '  return item.price;',
      '}',
      'module.exports = { lineTotal };',
      ''
    ].join('\n')
  };
}

function nodeProvisioningFiles() {
  return {
    ...nodeCartFiles(),
    '.gitignore': 'node_modules/\n',
    'package.json': JSON.stringify(
      {
        name: 'repo-matrix-node-provisioning',
        version: '1.0.0',
        dependencies: {
          'quantity-helper': 'file:vendor/quantity-helper'
        }
      },
      null,
      2
    ) + '\n',
    'package-lock.json': JSON.stringify(
      {
        name: 'repo-matrix-node-provisioning',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            name: 'repo-matrix-node-provisioning',
            version: '1.0.0',
            dependencies: {
              'quantity-helper': 'file:vendor/quantity-helper'
            }
          },
          'node_modules/quantity-helper': {
            resolved: 'vendor/quantity-helper',
            link: true
          },
          'vendor/quantity-helper': {
            version: '1.0.0'
          }
        }
      },
      null,
      2
    ) + '\n',
    'vendor/quantity-helper/package.json': JSON.stringify(
      {
        name: 'quantity-helper',
        version: '1.0.0',
        main: 'index.js'
      },
      null,
      2
    ) + '\n',
    'vendor/quantity-helper/index.js': 'module.exports = { quantity: 1 };\n'
  };
}

function nodePnpmProvisioningFiles() {
  return {
    ...nodeCartFiles(),
    '.gitignore': 'node_modules/\n',
    'package.json': JSON.stringify(
      {
        name: 'repo-matrix-pnpm-provisioning',
        version: '1.0.0',
        packageManager: 'pnpm@10.29.3',
        dependencies: {
          'quantity-helper': 'file:vendor/quantity-helper'
        }
      },
      null,
      2
    ) + '\n',
    'pnpm-lock.yaml': [
      "lockfileVersion: '9.0'",
      '',
      'settings:',
      '  autoInstallPeers: true',
      '  excludeLinksFromLockfile: false',
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      quantity-helper:',
      '        specifier: file:vendor/quantity-helper',
      '        version: file:vendor/quantity-helper',
      '',
      'packages:',
      '',
      '  quantity-helper@file:vendor/quantity-helper:',
      '    resolution: {directory: vendor/quantity-helper, type: directory}',
      '',
      'snapshots:',
      '',
      '  quantity-helper@file:vendor/quantity-helper: {}',
      ''
    ].join('\n'),
    'vendor/quantity-helper/package.json': JSON.stringify(
      {
        name: 'quantity-helper',
        version: '1.0.0',
        main: 'index.js'
      },
      null,
      2
    ) + '\n',
    'vendor/quantity-helper/index.js': 'module.exports = { quantity: 1 };\n'
  };
}

function nodeYarnProvisioningFiles() {
  return {
    ...nodeCartFiles(),
    '.gitignore': 'node_modules/\n',
    'package.json': JSON.stringify(
      {
        name: 'repo-matrix-yarn-provisioning',
        version: '1.0.0',
        packageManager: 'yarn@1.22.22',
        dependencies: {
          'quantity-helper': 'file:vendor/quantity-helper'
        }
      },
      null,
      2
    ) + '\n',
    'yarn.lock': [
      '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
      '# yarn lockfile v1',
      '',
      '',
      '"quantity-helper@file:vendor/quantity-helper":',
      '  version "1.0.0"',
      ''
    ].join('\n'),
    'vendor/quantity-helper/package.json': JSON.stringify(
      {
        name: 'quantity-helper',
        version: '1.0.0',
        main: 'index.js'
      },
      null,
      2
    ) + '\n',
    'vendor/quantity-helper/index.js': 'module.exports = { quantity: 1 };\n'
  };
}

function pythonCartFiles() {
  return {
    'src/cart.py': [
      'def line_total(item):',
      '    return item["price"]',
      ''
    ].join('\n')
  };
}

function rubyCartFiles() {
  return {
    'lib/cart.rb': [
      'def line_total(item)',
      '  item[:price]',
      'end',
      ''
    ].join('\n')
  };
}

function javaCartFiles() {
  return {
    'src/Cart.java': [
      'public final class Cart {',
      '  private Cart() {}',
      '',
      '  public static int lineTotal(int price, int quantity) {',
      '    return price;',
      '  }',
      '',
      '  public static int lineTotal(int price) {',
      '    return lineTotal(price, 1);',
      '  }',
      '}',
      ''
    ].join('\n')
  };
}

function swiftCartFiles() {
  return {
    'Sources/Cart.swift': [
      'public struct CartItem {',
      '  public let price: Int',
      '  public let quantity: Int?',
      '',
      '  public init(price: Int, quantity: Int? = nil) {',
      '    self.price = price',
      '    self.quantity = quantity',
      '  }',
      '}',
      '',
      'public func lineTotal(_ item: CartItem) -> Int {',
      '  item.price',
      '}',
      ''
    ].join('\n')
  };
}

function typescriptCartFiles() {
  return {
    'src/cart.ts': [
      'export interface CartItem {',
      '  price: number;',
      '  quantity?: number;',
      '}',
      '',
      'export function lineTotal(item: CartItem): number {',
      '  return item.price;',
      '}',
      ''
    ].join('\n')
  };
}

function djangoLikeFiles() {
  return {
    'manage.py': [
      '#!/usr/bin/env python3',
      'import sys',
      '',
      'if __name__ == "__main__":',
      '    print("django-like fixture", " ".join(sys.argv[1:]))',
      ''
    ].join('\n'),
    'shop/__init__.py': '',
    'shop/cart.py': [
      'def render_line(item):',
      '    return f"{item[\'name\']}: ${item[\'price\']}"',
      ''
    ].join('\n')
  };
}

function railsLikeFiles() {
  return {
    'app/models/cart_line.rb': [
      'class CartLine',
      '  def self.total(price:, quantity: nil)',
      '    price',
      '  end',
      'end',
      ''
    ].join('\n'),
    'config/application.rb': [
      'module CartApp',
      '  class Application',
      '  end',
      'end',
      ''
    ].join('\n')
  };
}

function androidGradleLikeFiles() {
  return {
    'settings.gradle': 'pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\n',
    'build.gradle': 'plugins { id "com.android.application" version "8.7.0" apply false }\n',
    'app/build.gradle': 'plugins { id "com.android.application" }\n',
    'app/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android" />\n',
    'app/src/main/java/com/example/cart/CartLine.java': [
      'package com.example.cart;',
      '',
      'public final class CartLine {',
      '  private CartLine() {}',
      '',
      '  public static int total(int price, int quantity) {',
      '    return price;',
      '  }',
      '}',
      ''
    ].join('\n')
  };
}

function standardCell(options) {
  return {
    kind: 'run',
    requires: [],
    expected: 'pass',
    ...options
  };
}

const cells = [
  standardCell({
    id: 'node-single',
    label: 'Node single package',
    corpus_axis: ['node', 'single-package'],
    files: nodeCartFiles(),
    writeScope: ['src/', 'tests/'],
    targetPaths: ['src/cart.cjs'],
    visibleCommand: 'node tests/cart-quantity.test.cjs',
    expectedChangedFiles: ['src/cart.cjs', 'tests/cart-quantity.test.cjs']
  }),
  standardCell({
    id: 'node-lockfile-provisioning',
    label: 'Node npm lockfile dependency provisioning',
    corpus_axis: ['node', 'dependency-provisioning'],
    files: nodeProvisioningFiles(),
    writeScope: ['src/', 'tests/'],
    targetPaths: ['src/cart.cjs'],
    visibleCommand: 'node tests/cart-quantity.test.cjs',
    expectedChangedFiles: ['src/cart.cjs', 'tests/cart-quantity.test.cjs'],
    expectedDependencyProvisioning: { status: 'cache_miss', manager: 'npm' }
  }),
  standardCell({
    id: 'node-pnpm-lockfile-provisioning',
    label: 'Node pnpm lockfile dependency provisioning',
    corpus_axis: ['node', 'dependency-provisioning', 'pnpm'],
    files: nodePnpmProvisioningFiles(),
    writeScope: ['src/', 'tests/'],
    targetPaths: ['src/cart.cjs'],
    visibleCommand: 'node tests/cart-quantity.test.cjs',
    expectedChangedFiles: ['src/cart.cjs', 'tests/cart-quantity.test.cjs'],
    expectedDependencyProvisioning: { status: 'cache_miss', manager: 'pnpm' }
  }),
  standardCell({
    id: 'node-yarn-lockfile-provisioning',
    label: 'Node yarn lockfile dependency provisioning',
    corpus_axis: ['node', 'dependency-provisioning', 'yarn'],
    files: nodeYarnProvisioningFiles(),
    writeScope: ['src/', 'tests/'],
    targetPaths: ['src/cart.cjs'],
    visibleCommand: 'node tests/cart-quantity.test.cjs',
    expectedChangedFiles: ['src/cart.cjs', 'tests/cart-quantity.test.cjs'],
    expectedDependencyProvisioning: { status: 'cache_miss', manager: 'yarn' }
  }),
  standardCell({
    id: 'python-stdlib',
    label: 'Python stdlib',
    corpus_axis: ['python'],
    requires: [{ command: 'python3', args: ['--version'] }],
    files: pythonCartFiles(),
    writeScope: ['src/', 'tests/'],
    targetPaths: ['src/cart.py'],
    visibleCommand: 'python3 tests/test_cart_quantity.py',
    expectedChangedFiles: ['src/cart.py', 'tests/test_cart_quantity.py']
  }),
  standardCell({
    id: 'ruby-stdlib',
    label: 'Ruby stdlib',
    corpus_axis: ['ruby-or-jvm'],
    requires: [{ command: 'ruby', args: ['--version'] }],
    files: rubyCartFiles(),
    writeScope: ['lib/', 'test/'],
    targetPaths: ['lib/cart.rb'],
    visibleCommand: 'ruby test/cart_quantity_test.rb',
    expectedChangedFiles: ['lib/cart.rb', 'test/cart_quantity_test.rb']
  }),
  standardCell({
    id: 'java-stdlib',
    label: 'Java stdlib',
    corpus_axis: ['java', 'jvm'],
    requires: [
      { command: javaTool('javac'), args: ['-version'] },
      { command: javaTool('java'), args: ['-version'] }
    ],
    files: javaCartFiles(),
    writeScope: ['src/', 'tests/'],
    targetPaths: ['src/Cart.java'],
    visibleCommand: javaVisibleCommand(),
    expectedChangedFiles: ['src/Cart.java', 'tests/CartQuantityTest.java']
  }),
  standardCell({
    id: 'swift-stdlib',
    label: 'Swift stdlib',
    corpus_axis: ['swift', 'compiled'],
    requires: [{ command: 'swiftc', args: ['--version'] }],
    files: swiftCartFiles(),
    writeScope: ['Sources/', 'Tests/'],
    targetPaths: ['Sources/Cart.swift'],
    visibleCommand: swiftVisibleCommand(),
    expectedChangedFiles: ['Sources/Cart.swift', 'Tests/main.swift']
  }),
  standardCell({
    id: 'typescript-esm',
    label: 'TypeScript ESM stdlib',
    corpus_axis: ['typescript', 'esm'],
    files: typescriptCartFiles(),
    writeScope: ['src/', 'tests/'],
    targetPaths: ['src/cart.ts'],
    visibleCommand: 'node tests/cart-quantity.test.ts',
    expectedChangedFiles: ['src/cart.ts', 'tests/cart-quantity.test.ts']
  }),
  standardCell({
    id: 'js-monorepo-scope',
    label: 'JS monorepo scoped package',
    corpus_axis: ['monorepo', 'scope-boundary'],
    files: {
      'package.json': '{"private":true,"workspaces":["packages/*"]}\n',
      'packages/cart/src/index.cjs': nodeCartFiles()['src/cart.cjs'],
      'packages/catalog/src/index.cjs': 'module.exports = { untouched: true };\n'
    },
    writeScope: ['packages/cart/'],
    targetPaths: ['packages/cart/src/index.cjs'],
    visibleCommand: 'node packages/cart/tests/cart-quantity.test.cjs',
    expectedChangedFiles: [
      'packages/cart/src/index.cjs',
      'packages/cart/tests/cart-quantity.test.cjs'
    ],
    forbiddenChangedPrefixes: ['packages/catalog/']
  }),
  standardCell({
    id: 'react-next-like',
    label: 'React/Next-like frontend utility',
    corpus_axis: ['react-next-like'],
    files: {
      'package.json': '{"scripts":{"test":"node tests/cart-view.test.cjs"}}\n',
      'app/cart-view.cjs': [
        'function renderLine(item) {',
        '  return `${item.name}: $${item.price}`;',
        '}',
        'module.exports = { renderLine };',
        ''
      ].join('\n')
    },
    writeScope: ['app/', 'tests/'],
    targetPaths: ['app/cart-view.cjs'],
    visibleCommand: 'node tests/cart-view.test.cjs',
    expectedChangedFiles: ['app/cart-view.cjs', 'tests/cart-view.test.cjs']
  }),
  standardCell({
    id: 'django-like-service',
    label: 'Django-like Python service',
    corpus_axis: ['django-like', 'python', 'web-service'],
    requires: [{ command: 'python3', args: ['--version'] }],
    files: djangoLikeFiles(),
    writeScope: ['shop/', 'tests/'],
    targetPaths: ['shop/cart.py'],
    visibleCommand: 'python3 tests/test_cart_view.py',
    expectedChangedFiles: ['shop/cart.py', 'tests/test_cart_view.py']
  }),
  standardCell({
    id: 'rails-like-service',
    label: 'Rails-like Ruby service',
    corpus_axis: ['rails-like', 'ruby', 'web-service'],
    requires: [{ command: 'ruby', args: ['--version'] }],
    files: railsLikeFiles(),
    writeScope: ['app/models/', 'test/'],
    targetPaths: ['app/models/cart_line.rb'],
    visibleCommand: 'ruby test/models/cart_line_test.rb',
    expectedChangedFiles: [
      'app/models/cart_line.rb',
      'test/models/cart_line_test.rb'
    ]
  }),
  standardCell({
    id: 'android-gradle-like',
    label: 'Android/Gradle-like Java module',
    corpus_axis: ['android-gradle-like', 'java', 'mobile'],
    requires: [
      { command: javaTool('javac'), args: ['-version'] },
      { command: javaTool('java'), args: ['-version'] }
    ],
    files: androidGradleLikeFiles(),
    writeScope: ['app/src/main/java/', 'app/src/test/java/'],
    targetPaths: ['app/src/main/java/com/example/cart/CartLine.java'],
    visibleCommand: [
      'rm -rf out',
      'mkdir -p out',
      `${shSingleQuote(javaTool('javac'))} -d out app/src/main/java/com/example/cart/CartLine.java app/src/test/java/com/example/cart/CartLineTest.java`,
      `${shSingleQuote(javaTool('java'))} -cp out com.example.cart.CartLineTest`
    ].join(' && '),
    expectedChangedFiles: [
      'app/src/main/java/com/example/cart/CartLine.java',
      'app/src/test/java/com/example/cart/CartLineTest.java'
    ]
  }),
  standardCell({
    id: 'cli-tool',
    label: 'CLI tool repo',
    corpus_axis: ['cli-tool'],
    files: {
      'bin/cart-total.cjs': [
        '#!/usr/bin/env node',
        'const price = Number(process.argv[2]);',
        'console.log(price);',
        ''
      ].join('\n')
    },
    writeScope: ['bin/', 'tests/'],
    targetPaths: ['bin/cart-total.cjs'],
    visibleCommand: 'node tests/cli-cart-total.test.cjs',
    expectedChangedFiles: ['bin/cart-total.cjs', 'tests/cli-cart-total.test.cjs']
  }),
  standardCell({
    id: 'no-package-manager',
    label: 'No package manager repo',
    corpus_axis: ['no-package-manager'],
    files: nodeCartFiles(),
    writeScope: ['src/', 'tests/'],
    targetPaths: ['src/cart.cjs'],
    visibleCommand: 'node tests/cart-quantity.test.cjs',
    expectedChangedFiles: ['src/cart.cjs', 'tests/cart-quantity.test.cjs'],
    expectNoPackageManager: true,
    expectedDependencyProvisioning: { status: 'skipped' }
  }),
  standardCell({
    id: 'large-file-count',
    label: 'Large-ish file count repo',
    corpus_axis: ['large'],
    files: Object.fromEntries([
      ...Object.entries(nodeCartFiles()),
      ...Array.from({ length: 240 }, (_, index) => [
        `docs/generated-${String(index).padStart(3, '0')}.md`,
        `# Generated fixture ${index}\n\nThis file makes the matrix cell non-trivial.\n`
      ])
    ]),
    writeScope: ['src/', 'tests/'],
    targetPaths: ['src/cart.cjs'],
    visibleCommand: 'node tests/cart-quantity.test.cjs',
    expectedChangedFiles: ['src/cart.cjs', 'tests/cart-quantity.test.cjs'],
    minFileCount: 240
  }),
  {
    id: 'dirty-worktree',
    label: 'Dirty source repo guard',
    corpus_axis: ['dirty-worktree'],
    kind: 'dirty_guard',
    requires: [],
    files: nodeCartFiles(),
    writeScope: ['src/', 'tests/'],
    targetPaths: ['src/cart.cjs'],
    visibleCommand: 'node tests/cart-quantity.test.cjs',
    expected: 'blocked'
  },
  {
    id: 'network-restricted-r1',
    label: 'R1 network none gate',
    corpus_axis: ['network-restricted'],
    kind: 'run',
    requires: [{ command: 'docker', args: ['info'] }],
    files: nodeCartFiles(),
    writeScope: ['src/', 'tests/'],
    targetPaths: ['src/cart.cjs'],
    visibleCommand: 'node tests/cart-quantity.test.cjs',
    expectedChangedFiles: ['src/cart.cjs', 'tests/cart-quantity.test.cjs'],
    execution: { isolation: 'container', image: 'node:22-alpine', network: 'none' },
    expected: 'pass'
  }
];

function fixFilesForCell(id) {
  switch (id) {
    case 'python-stdlib':
      return {
        'src/cart.py': [
          'def line_total(item):',
          '    return item["price"] * item.get("quantity", 1)',
          ''
        ].join('\n'),
        'tests/test_cart_quantity.py': [
          'import sys',
          "sys.path.insert(0, 'src')",
          'from cart import line_total',
          'assert line_total({"price": 4, "quantity": 3}) == 12',
          'assert line_total({"price": 4}) == 4',
          ''
        ].join('\n')
      };
    case 'ruby-stdlib':
      return {
        'lib/cart.rb': [
          'def line_total(item)',
          '  item[:price] * (item[:quantity] || 1)',
          'end',
          ''
        ].join('\n'),
        'test/cart_quantity_test.rb': [
          "require_relative '../lib/cart'",
          "abort('quantity not applied') unless line_total({ price: 4, quantity: 3 }) == 12",
          "abort('default quantity broken') unless line_total({ price: 4 }) == 4",
          ''
        ].join('\n')
      };
    case 'java-stdlib':
      return {
        'src/Cart.java': [
          'public final class Cart {',
          '  private Cart() {}',
          '',
          '  public static int lineTotal(int price, int quantity) {',
          '    return price * quantity;',
          '  }',
          '',
          '  public static int lineTotal(int price) {',
          '    return lineTotal(price, 1);',
          '  }',
          '}',
          ''
        ].join('\n'),
        'tests/CartQuantityTest.java': [
          'public final class CartQuantityTest {',
          '  public static void main(String[] args) {',
          "    assertEquals(12, Cart.lineTotal(4, 3), \"quantity not applied\");",
          "    assertEquals(4, Cart.lineTotal(4), \"default quantity broken\");",
          '  }',
          '',
          '  private static void assertEquals(int expected, int actual, String message) {',
          '    if (expected != actual) {',
          '      throw new AssertionError(message + ": expected " + expected + ", got " + actual);',
          '    }',
          '  }',
          '}',
          ''
        ].join('\n')
      };
    case 'swift-stdlib':
      return {
        'Sources/Cart.swift': [
          'public struct CartItem {',
          '  public let price: Int',
          '  public let quantity: Int?',
          '',
          '  public init(price: Int, quantity: Int? = nil) {',
          '    self.price = price',
          '    self.quantity = quantity',
          '  }',
          '}',
          '',
          'public func lineTotal(_ item: CartItem) -> Int {',
          '  item.price * (item.quantity ?? 1)',
          '}',
          ''
        ].join('\n'),
        'Tests/main.swift': [
          'func assertEqual(_ expected: Int, _ actual: Int, _ message: String) {',
          '  if expected != actual {',
          '    fatalError("\\(message): expected \\(expected), got \\(actual)")',
          '  }',
          '}',
          '',
          'assertEqual(12, lineTotal(CartItem(price: 4, quantity: 3)), "quantity not applied")',
          'assertEqual(4, lineTotal(CartItem(price: 4)), "default quantity broken")',
          ''
        ].join('\n')
      };
    case 'typescript-esm':
      return {
        'src/cart.ts': [
          'export interface CartItem {',
          '  price: number;',
          '  quantity?: number;',
          '}',
          '',
          'export function lineTotal(item: CartItem): number {',
          '  return item.price * (item.quantity ?? 1);',
          '}',
          ''
        ].join('\n'),
        'tests/cart-quantity.test.ts': [
          "import { lineTotal } from '../src/cart.ts';",
          '',
          "if (lineTotal({ price: 4, quantity: 3 }) !== 12) throw new Error('quantity not applied');",
          "if (lineTotal({ price: 4 }) !== 4) throw new Error('default quantity broken');",
          ''
        ].join('\n')
      };
    case 'js-monorepo-scope':
      return {
        'packages/cart/src/index.cjs': [
          'function lineTotal(item) {',
          '  return item.price * (item.quantity ?? 1);',
          '}',
          'module.exports = { lineTotal };',
          ''
        ].join('\n'),
        'packages/cart/tests/cart-quantity.test.cjs': [
          "const { lineTotal } = require('../src/index.cjs');",
          "if (lineTotal({ price: 4, quantity: 3 }) !== 12) throw new Error('quantity not applied');",
          "if (lineTotal({ price: 4 }) !== 4) throw new Error('default quantity broken');",
          ''
        ].join('\n')
      };
    case 'react-next-like':
      return {
        'app/cart-view.cjs': [
          'function renderLine(item) {',
          '  return `${item.name} x${item.quantity ?? 1}: $${item.price * (item.quantity ?? 1)}`;',
          '}',
          'module.exports = { renderLine };',
          ''
        ].join('\n'),
        'tests/cart-view.test.cjs': [
          "const { renderLine } = require('../app/cart-view.cjs');",
          "const rendered = renderLine({ name: 'Widget', price: 4, quantity: 3 });",
          "if (!rendered.includes('x3')) throw new Error('quantity missing from view');",
          "if (!rendered.includes('$12')) throw new Error('line total missing from view');",
          ''
        ].join('\n')
      };
    case 'django-like-service':
      return {
        'shop/cart.py': [
          'def render_line(item):',
          '    quantity = item.get("quantity", 1)',
          '    return f"{item[\'name\']} x{quantity}: ${item[\'price\'] * quantity}"',
          ''
        ].join('\n'),
        'tests/test_cart_view.py': [
          'import sys',
          "sys.path.insert(0, '.')",
          'from shop.cart import render_line',
          '',
          'rendered = render_line({"name": "Widget", "price": 4, "quantity": 3})',
          'assert "x3" in rendered',
          'assert "$12" in rendered',
          ''
        ].join('\n')
      };
    case 'rails-like-service':
      return {
        'app/models/cart_line.rb': [
          'class CartLine',
          '  def self.total(price:, quantity: nil)',
          '    price * (quantity || 1)',
          '  end',
          'end',
          ''
        ].join('\n'),
        'test/models/cart_line_test.rb': [
          "require_relative '../../app/models/cart_line'",
          "abort('quantity not applied') unless CartLine.total(price: 4, quantity: 3) == 12",
          "abort('default quantity broken') unless CartLine.total(price: 4) == 4",
          ''
        ].join('\n')
      };
    case 'android-gradle-like':
      return {
        'app/src/main/java/com/example/cart/CartLine.java': [
          'package com.example.cart;',
          '',
          'public final class CartLine {',
          '  private CartLine() {}',
          '',
          '  public static int total(int price, int quantity) {',
          '    return price * quantity;',
          '  }',
          '}',
          ''
        ].join('\n'),
        'app/src/test/java/com/example/cart/CartLineTest.java': [
          'package com.example.cart;',
          '',
          'public final class CartLineTest {',
          '  public static void main(String[] args) {',
          '    if (CartLine.total(4, 3) != 12) {',
          '      throw new AssertionError("quantity not applied");',
          '    }',
          '  }',
          '}',
          ''
        ].join('\n')
      };
    case 'cli-tool':
      return {
        'bin/cart-total.cjs': [
          '#!/usr/bin/env node',
          'const price = Number(process.argv[2]);',
          'const quantity = Number(process.argv[3] ?? 1);',
          'console.log(price * quantity);',
          ''
        ].join('\n'),
        'tests/cli-cart-total.test.cjs': [
          "const { execFileSync } = require('node:child_process');",
          "const out = execFileSync(process.execPath, ['bin/cart-total.cjs', '4', '3'], { encoding: 'utf8' }).trim();",
          "if (out !== '12') throw new Error(`expected 12, got ${out}`);",
          ''
        ].join('\n')
      };
    default:
      return {
        'src/cart.cjs': [
          'function lineTotal(item) {',
          '  return item.price * (item.quantity ?? 1);',
          '}',
          'module.exports = { lineTotal };',
          ''
        ].join('\n'),
        'tests/cart-quantity.test.cjs': [
          "const { lineTotal } = require('../src/cart.cjs');",
          "if (lineTotal({ price: 4, quantity: 3 }) !== 12) throw new Error('quantity not applied');",
          "if (lineTotal({ price: 4 }) !== 4) throw new Error('default quantity broken');",
          ''
        ].join('\n')
      };
  }
}

async function writeAgentScript(root) {
  const fixes = Object.fromEntries(cells.map((cell) => [cell.id, fixFilesForCell(cell.id)]));
  const agentFile = path.join(root, 'repo-matrix-agent.cjs');
  await writeFile(
    agentFile,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const fixes = ${JSON.stringify(fixes, null, 2)};`,
      "const cell = process.env.VIBELOOP_REPO_MATRIX_CELL;",
      "if (!cell || !fixes[cell]) throw new Error(`unknown matrix cell: ${cell}`);",
      "for (const [relativePath, content] of Object.entries(fixes[cell])) {",
      '  const target = path.join(process.cwd(), relativePath);',
      '  fs.mkdirSync(path.dirname(target), { recursive: true });',
      '  fs.writeFileSync(target, content);',
      '}',
      "console.log(`repo-matrix fixed ${cell}`);",
      ''
    ].join('\n')
  );
  return agentFile;
}

function taskYaml(cell) {
  return [
    "schema_version: '1.0'",
    `id: ${cell.id}`,
    `title: ${yamlSingleQuote(cell.label)}`,
    `objective: ${yamlSingleQuote(`Fix the ${cell.label} quantity bug and add a regression test.`)}`,
    'base_branch: main',
    'risk_area: none',
    'write_scope:',
    '  allowed:',
    ...cell.writeScope.map((scope) => `    - ${scope}`),
    'required_evidence:',
    '  - adds_regression_test',
    'acceptance:',
    '  required_tests:',
    `    - ${yamlSingleQuote(cell.visibleCommand)}`,
    'limits:',
    '  max_changed_files: 8',
    '  max_changed_lines: 220',
    '  agent_timeout_seconds: 90',
    ''
  ].join('\n');
}

function evalYaml(cell) {
  const execution = cell.execution ?? { isolation: 'none' };
  return [
    "schema_version: '1.0'",
    `project: ${cell.id}`,
    'protected_paths:',
    '  - .env',
    '  - .env.*',
    '  - eval.yaml',
    'risk_classification:',
    '  none:',
    ...cell.writeScope.map((scope) => `    - ${scope}`),
    'limits:',
    '  max_changed_files: 8',
    '  max_changed_lines: 220',
    'test_integrity:',
    '  forbidden_patterns:',
    '    - test.skip',
    '    - it.only',
    '    - describe.only',
    '  suspicious_patterns:',
    '    - expect(true).toBe(true)',
    'evaluator:',
    '  min_evidence_present: 1',
    '  max_changed_files: 8',
    '  max_changed_lines: 220',
    '  forbid_protected: true',
    '  target_paths:',
    ...cell.targetPaths.map((targetPath) => `    - ${targetPath}`),
    'execution:',
    `  isolation: ${execution.isolation}`,
    ...(execution.image ? [`  image: ${execution.image}`] : []),
    ...(execution.network ? [`  network: ${execution.network}`] : []),
    'gates:',
    '  - name: git_meta_integrity',
    '    type: integrity',
    '    command: builtin:git-meta-integrity',
    '    required: true',
    '  - name: protected_files',
    '    type: scope',
    '    command: builtin:protected-files',
    '    required: true',
    '  - name: diff_scope',
    '    type: scope',
    '    command: builtin:diff-scope',
    '    required: true',
    '  - name: limits',
    '    type: integrity',
    '    command: builtin:limits',
    '    required: true',
    '  - name: test_integrity',
    '    type: integrity',
    '    command: builtin:test-integrity',
    '    required: true',
    '  - name: visible_regression',
    '    type: task_acceptance',
    `    command: ${yamlSingleQuote(cell.visibleCommand)}`,
    '    required: true',
    ''
  ].join('\n');
}

async function createRepo(root, cell) {
  const repoPath = path.join(root, `repo-${cell.id}`);
  await mkdir(repoPath, { recursive: true });
  await writeFiles(repoPath, cell.files);
  await writeFile(path.join(repoPath, 'task.yaml'), taskYaml(cell));
  await writeFile(path.join(repoPath, 'eval.yaml'), evalYaml(cell));
  await git(repoPath, ['init', '-b', 'main']);
  await git(repoPath, ['config', 'user.email', 'repo-matrix@example.test']);
  await git(repoPath, ['config', 'user.name', 'Repo Matrix UAT']);
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', `initial ${cell.id} fixture`]);
  const baseCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  return {
    repoPath,
    taskFile: path.join(repoPath, 'task.yaml'),
    evalFile: path.join(repoPath, 'eval.yaml'),
    baseCommit
  };
}

async function checkRequirements(cell) {
  const missing = [];
  for (const required of cell.requires ?? []) {
    if (!(await commandAvailable(required.command, required.args))) {
      missing.push(required.command);
    }
  }
  return missing;
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label} did not return JSON stdout:\n${redact(stdout)}`);
  }
}

async function readJsonFile(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `${label} could not be read as JSON at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function runDiscover(repoPath, evalFile) {
  const result = await runCommand(process.execPath, [
    CLI,
    'discover',
    '--repo',
    repoPath,
    '--eval',
    evalFile
  ]);
  if (result.code !== 0 || result.stderr !== '') {
    throw new Error(
      `discover failed (${result.code})\nstdout:\n${redact(result.stdout)}\nstderr:\n${redact(result.stderr)}`
    );
  }
  const parsed = parseJson(result.stdout, 'discover');
  if (!Array.isArray(parsed.candidates)) {
    throw new Error('discover output did not include candidates array');
  }
  return parsed.candidates.length;
}

async function runMatrixCell({ cell, root, dataRoot, agentScript }) {
  const missing = await checkRequirements(cell);
  if (missing.length > 0) {
    return {
      id: cell.id,
      label: cell.label,
      status: 'unsupported',
      expected: cell.expected,
      corpus_axis: cell.corpus_axis,
      reason: `missing tool: ${missing.join(', ')}`,
      provisioning: {
        status: 'unsupported',
        reason: 'missing_required_tool',
        missing_tools: missing
      }
    };
  }

  const repo = await createRepo(root, cell);
  const fileCount = await countFiles(repo.repoPath);
  if (cell.expectNoPackageManager && (await pathExists(path.join(repo.repoPath, 'package.json')))) {
    throw new Error(`${cell.id} unexpectedly has package.json`);
  }
  if (cell.minFileCount && fileCount < cell.minFileCount) {
    throw new Error(`${cell.id} expected at least ${cell.minFileCount} files, got ${fileCount}`);
  }
  const discoverCount = await runDiscover(repo.repoPath, repo.evalFile);

  if (cell.kind === 'dirty_guard') {
    await writeFile(path.join(repo.repoPath, 'UNCOMMITTED.txt'), 'dirty source\n');
    const dirty = await runCommand(process.execPath, [
      CLI,
      '--data-dir',
      dataRoot,
      'improve',
      '--repo',
      repo.repoPath,
      '--task',
      repo.taskFile,
      '--eval',
      repo.evalFile,
      '--agent',
      `command:VIBELOOP_REPO_MATRIX_CELL=${cell.id} node ${shSingleQuote(agentScript)}`,
      '--project-id',
      cell.id,
      '--loop-id',
      `${cell.id}-${RUN_TAG}`,
      '--max-candidates',
      '1'
    ]);
    const blocked =
      dirty.code !== 0 &&
      `${dirty.stdout}\n${dirty.stderr}`.includes('Source repo has') &&
      `${dirty.stdout}\n${dirty.stderr}`.includes('uncommitted');
    if (!blocked) {
      throw new Error(
        `dirty guard did not block as expected (${dirty.code})\nstdout:\n${redact(
          dirty.stdout
        )}\nstderr:\n${redact(dirty.stderr)}`
      );
    }
    return {
      id: cell.id,
      label: cell.label,
      status: 'blocked',
      expected: cell.expected,
      corpus_axis: cell.corpus_axis,
      discover_count: discoverCount,
      reason: 'dirty_source_guard',
      provisioning: {
        status: 'not_run',
        reason: 'blocked_before_workspace_preparation'
      },
      repo: repo.repoPath
    };
  }

  const result = await runCommand(process.execPath, [
    CLI,
    '--data-dir',
    dataRoot,
    'run',
    '--repo',
    repo.repoPath,
    '--task',
    repo.taskFile,
    '--eval',
    repo.evalFile,
    '--agent',
    `command:VIBELOOP_REPO_MATRIX_CELL=${cell.id} node ${shSingleQuote(agentScript)}`,
    '--project-id',
    cell.id,
    '--loop-id',
    `${cell.id}-${RUN_TAG}`,
    '--base-commit',
    repo.baseCommit
  ]);
  if (result.code !== 0 || result.stderr !== '') {
    throw new Error(
      `${cell.id} run failed (${result.code})\nstdout:\n${redact(result.stdout)}\nstderr:\n${redact(result.stderr)}`
    );
  }
  const output = parseJson(result.stdout, `${cell.id} run`);
  if (!output.artifact_root) {
    throw new Error(`${cell.id} run did not report artifact_root`);
  }
  const workspaceRef = await readJsonFile(
    path.join(output.artifact_root, 'workspace', 'workspace-ref.json'),
    `${cell.id} workspace-ref`
  );
  const dependencyProvisioning = workspaceRef.dependency_provisioning ?? null;
  if (!dependencyProvisioning?.status) {
    throw new Error(`${cell.id} workspace-ref omitted dependency_provisioning`);
  }
  if (cell.expectedDependencyProvisioning) {
    for (const [key, expectedValue] of Object.entries(
      cell.expectedDependencyProvisioning
    )) {
      if (dependencyProvisioning[key] !== expectedValue) {
        throw new Error(
          `${cell.id} dependency provisioning ${key} expected ${expectedValue}, got ${dependencyProvisioning[key]}`
        );
      }
    }
  }
  if (
    output.status !== 'accepted' ||
    output.decision !== 'accept' ||
    output.qualified !== true ||
    output.pr_candidate !== true
  ) {
    throw new Error(`${cell.id} was not accepted as PR candidate: ${result.stdout}`);
  }
  const report = JSON.parse(await readFile(output.report, 'utf8'));
  const changedFiles = report.changed_files.map((file) => file.path).sort();
  const expectedChangedFiles = [...cell.expectedChangedFiles].sort();
  if (JSON.stringify(changedFiles) !== JSON.stringify(expectedChangedFiles)) {
    throw new Error(
      `${cell.id} changed unexpected files: ${JSON.stringify(changedFiles)}`
    );
  }
  for (const forbiddenPrefix of cell.forbiddenChangedPrefixes ?? []) {
    if (changedFiles.some((file) => file.startsWith(forbiddenPrefix))) {
      throw new Error(`${cell.id} changed forbidden prefix ${forbiddenPrefix}`);
    }
  }
  const requiredFailed = report.gate_runs.filter(
    (gate) => gate.required && gate.status !== 'pass'
  );
  if (requiredFailed.length > 0) {
    throw new Error(
      `${cell.id} had failed required gates: ${JSON.stringify(requiredFailed)}`
    );
  }
  const status = await git(repo.repoPath, ['status', '--short']);
  if (status.trim() !== '') {
    throw new Error(`${cell.id} source repo should remain clean, got ${status}`);
  }
  return {
    id: cell.id,
    label: cell.label,
    status: 'pass',
    expected: cell.expected,
    corpus_axis: cell.corpus_axis,
    discover_count: discoverCount,
    repo: repo.repoPath,
    report: output.report,
    artifact_root: output.artifact_root,
    dependency_provisioning: dependencyProvisioning,
    changed_files: changedFiles,
    file_count: fileCount
  };
}

function dependencyProvisioningSummary(results) {
  const statuses = {};
  for (const result of results) {
    const status =
      result.dependency_provisioning?.status ?? result.provisioning?.status;
    if (!status) continue;
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
  return {
    checked_count: results.filter(
      (result) =>
        result.dependency_provisioning?.status || result.provisioning?.status
    ).length,
    statuses
  };
}

async function main() {
  const evidenceRoot =
    process.env.VIBELOOP_UAT_EVIDENCE_DIR ||
    path.join(os.homedir(), '.vibeloop', 'uat-evidence');
  const bundle = path.join(evidenceRoot, 'repo-matrix-uat', RUN_TAG);
  const root = path.join(bundle, 'workspace');
  const dataRoot = path.join(root, 'data');
  await mkdir(dataRoot, { recursive: true });
  const agentScript = await writeAgentScript(root);
  try {
    const results = [];
    for (const cell of cells) {
      results.push(await runMatrixCell({ cell, root, dataRoot, agentScript }));
    }
    const failures = results.filter((result) => result.status === 'fail');
    const output = {
      status: failures.length === 0 ? 'REPO_MATRIX_PASS' : 'REPO_MATRIX_FAIL',
      scenario: 'repo-matrix-uat',
      run_id: RUN_TAG,
      evidence_bundle: bundle,
      targetRoot: PRUNE ? '[pruned]' : root,
      cell_count: results.length,
      pass_count: results.filter((result) => result.status === 'pass').length,
      blocked_count: results.filter((result) => result.status === 'blocked').length,
      unsupported_count: results.filter((result) => result.status === 'unsupported').length,
      fail_count: failures.length,
      dependency_provisioning: dependencyProvisioningSummary(results),
      cells: results
    };
    const evidenceBundle = await writeUatEvidenceBundle({
      scenario: output.scenario,
      runId: output.run_id,
      tmpRoot: root,
      dataDir: dataRoot,
      outputs: results,
      output,
      evidenceDir: evidenceRoot
    });
    output.evidence_bundle = evidenceBundle.bundle_dir;
    output.evidence_manifest = evidenceBundle.manifest_path;
    output.ledger = path.join(evidenceBundle.bundle_dir, 'ledger.json');
    output.evidence_copied_count = evidenceBundle.copied_count + 1;
    output.evidence_missing_count = evidenceBundle.missing_count;
    await writeUatEvidenceLedger(evidenceBundle, output);
    console.log(JSON.stringify(output, null, 2));
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    if (PRUNE) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});

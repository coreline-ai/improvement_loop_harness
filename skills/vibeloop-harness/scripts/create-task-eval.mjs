#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { template: 'node', out: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replaceAll('-', '_');
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

function requireString(args, key, fallback) {
  const value = args[key] ?? fallback;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`missing --${key.replaceAll('_', '-')}`);
  }
  return value.trim();
}

function templateName(kind) {
  if (kind === 'node') return 'eval-node.yaml';
  if (kind === 'python') return 'eval-python.yaml';
  if (kind === 'web') return 'eval-web.yaml';
  throw new Error(`unsupported --template ${kind}; expected node, python, or web`);
}

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(String(args.out));
const id = requireString(args, 'id', 'vibeloop-task');
const title = requireString(args, 'title', 'Fix one bounded issue');
const objective = requireString(
  args,
  'objective',
  'Fix exactly one issue and add or update a regression test that proves the fix.'
);
const project = requireString(args, 'project', id);
const template = requireString(args, 'template', 'node');

await mkdir(outDir, { recursive: true });
const taskTemplate = await readFile(path.join(skillRoot, 'templates/task-minimal.yaml'), 'utf8');
const evalTemplate = await readFile(path.join(skillRoot, 'templates', templateName(template)), 'utf8');
const task = taskTemplate
  .replace(/^id: .+$/m, `id: ${id}`)
  .replace(/^title: .+$/m, `title: ${title}`)
  .replace(/^objective: .+$/m, `objective: ${objective}`);
const evalYaml = evalTemplate.replace(/^project: .+$/m, `project: ${project}`);
await writeFile(path.join(outDir, 'task.yaml'), task);
await writeFile(path.join(outDir, 'eval.yaml'), evalYaml);
console.log(JSON.stringify({ task: path.join(outDir, 'task.yaml'), eval: path.join(outDir, 'eval.yaml') }, null, 2));

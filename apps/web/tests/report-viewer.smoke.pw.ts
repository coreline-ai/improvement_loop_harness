import { expect, test } from '@playwright/test';

test('projects to detail to report shows ALL_PASS and SSE reconnect dedups events', async ({ page }) => {
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await page.getByText('Fixture Project').click();

  await expect(page.getByRole('heading', { name: 'Fixture Project' })).toBeVisible();
  await page.getByRole('link', { name: 'details' }).click();
  await expect(page.getByRole('heading', { name: 'loop-happy' })).toBeVisible();
  await expect(page.getByText('unit_tests')).toBeVisible();

  await expect(page.getByTestId('event-line')).toHaveCount(3);
  const lines = await page.getByTestId('event-line').allTextContents();
  expect(new Set(lines).size).toBe(3);
  expect(lines.join('\n')).toContain('#3 gate.completed');

  await page.getByRole('link', { name: 'open report →' }).click();
  await expect(page.getByTestId('all-pass')).toHaveText('ALL_PASS');
  await expect(page.getByText('ALL_GATES_PASS')).toBeVisible();
  await expect(page.getByRole('link', { name: 'artifact: logs/gates/unit.stdout.log' })).toBeVisible();
});

test('approval queue submits one approval action', async ({ page }) => {
  await page.goto('/approvals');
  await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible();
  await page.getByPlaceholder('decision_reason').fill('Smoke approval after evidence review.');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('approved')).toBeVisible();
});

test('missing loop renders 404', async ({ page }) => {
  await page.goto('/loops/missing/report');
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
});

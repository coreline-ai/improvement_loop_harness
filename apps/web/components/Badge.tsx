import { badgeClass } from '../lib/api';

export function Badge({ value }: { value?: string | null }) {
  return <span className={badgeClass(value)}>{value ?? 'unknown'}</span>;
}

import { redirect } from 'next/navigation';

import { getCurrentAccount } from '@/lib/auth/account';
import { canManageMonthlyPayments } from '@/lib/auth/roles';

import { MonthlyPaymentsClient } from './monthly-payments-client';

export const dynamic = 'force-dynamic';

export default async function MonthlyPaymentsPage() {
  const { role } = await getCurrentAccount();
  if (!canManageMonthlyPayments(role)) redirect('/dashboard');
  return <MonthlyPaymentsClient />;
}

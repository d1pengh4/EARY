import type { Scenario } from '@eary/schema';
import impersonation from './impersonation-01.json';
import billing from './billing-01.json';

export const SCENARIOS: Record<string, Scenario> = {
  [impersonation.id]: impersonation as Scenario,
  [billing.id]: billing as Scenario,
};

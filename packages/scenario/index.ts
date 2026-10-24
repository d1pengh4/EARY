import type { Scenario } from '@eary/schema';
import impersonation from './impersonation-01.json';
import billing from './billing-01.json';
import prosecutor from './prosecutor-02.json';

export const SCENARIOS: Record<string, Scenario> = {
  [impersonation.id]: impersonation as Scenario,
  [billing.id]: billing as Scenario,
  [prosecutor.id]: prosecutor as Scenario,
};

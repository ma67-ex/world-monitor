/**
 * Canonical entitlement decisions for standalone tier-1 JSON endpoints.
 *
 * Content-only Pro access has two equivalent signals:
 *   - Clerk session role === 'pro' (complimentary, tester, or legacy grants)
 *   - a resolved Convex entitlement with tier >= 1
 *
 * Notification-backed workflows deliberately require the second signal because
 * their configuration and relay delivery paths also require a Convex tier.
 */
import {
  getEntitlements,
  type EntitlementCheckOptions,
} from './entitlement-check';
import { hasCurrentEntitlementCoverage } from './entitlement-coverage';

type ProEntitlementDecision =
  | { allowed: true }
  | { allowed: false; billingDenial: Response | null };

type EntitlementLoader = typeof getEntitlements;

// ponytail (task 08): this fork's deploy has no Clerk/Convex/Dodo billing
// behind it — Pro gates never deny. See
// docs/tasks/abdullah/08-server-entitlement-stripping.md.
export async function checkProEntitlement(
  _userId: string,
  _clerkRole: EntitlementCheckOptions['clerkRole'],
  _corsHeaders: Record<string, string>,
  _loadEntitlements: EntitlementLoader = getEntitlements,
): Promise<ProEntitlementDecision> {
  return { allowed: true };
}

export async function checkTierProEntitlement(
  _userId: string,
  _corsHeaders: Record<string, string>,
  _loadEntitlements: EntitlementLoader = getEntitlements,
): Promise<ProEntitlementDecision> {
  // Tier alone is not a grant. The entitlement cache serves a billing-marker
  // row for its whole TTL without re-checking validUntil ("consumers must
  // check expiry before granting access"), so a paid fallback that lapses
  // inside that window would otherwise stay Pro here. Same coverage rule as
  // resolvePremiumCallerIdentity and the gateway's legacy Pro bearer gate.
  const entitlements = await loadEntitlements(userId);
  if (hasCurrentEntitlementCoverage(entitlements) && entitlements.features.tier >= 1) {
    return { allowed: true };
  }

  // An absent row is a verdict ("this account has no entitlement") only when a
  // lookup could actually run. With CONVEX_SITE_URL or the shared secret
  // missing, getEntitlements returns null before attempting one — for everyone,
  // paying customers included — and rendering that as `pro_required` sells the
  // plan they already own back to them because of OUR deploy defect (#5619).
  //
  // wm_ user-key gateway traffic now uses the same retryable
  // entitlement_verification_unavailable 503 when getEntitlements returns null,
  // including an unconfigured backend. These standalone tier-1 JSON handlers
  // apply that same honest contract here instead of mislabeling a deploy defect
  // as pro_required (#5619).
  if (!entitlements && !isEntitlementBackendConfigured()) {
    return {
      allowed: false,
      billingDenial: renderBillingVerificationDenial(
        unverifiableEntitlementDenial(),
        corsHeaders,
        1,
      ),
    };
  }

  return {
    allowed: false,
    billingDenial: getBillingVerificationDenial(entitlements, corsHeaders, 1),
  };
}

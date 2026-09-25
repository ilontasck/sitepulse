# Closed beta and public launch gates

This is a reviewable release candidate, **not yet an externally hosted beta**. No deployment or main merge was performed. Current code and test evidence: [SOURCE-OF-TRUTH](SOURCE-OF-TRUTH.md).

## Closed beta — blockers

| Gate | Required completion | Owner |
| --- | --- | --- |
| Actual production host | Select/provision Linux VM, TLS/domain and private configuration; deploy the exact release together; verify systemd, nftables/runner sandbox, migrations, health, reboot/crash recovery and resource limits | Operator |
| Legal facts and publication | Supply genuine operator/contact/address, hosting/location and publication values privately; review draft legal text and make checker pass against that configuration | Owner + legal reviewer |
| Retention completeness | Decide retention for failed jobs without reports, physical reset-token records, logs/backups/provider data and whether internal pro may be used; implement cleanup and test it. Verify existing 29-day purge eligibility/30-day target under backlog and downtime | Owner decision + engineering/operator |
| Invitation, deletion and recovery | Keep registration closed. Establish tested provisioning and identity-verified deletion/recovery support, or implement the missing invitation/account-deletion UI and email provider. Never request a user's password through support | Owner + engineering |
| Operations | Tested encrypted backup/restore and rollback; cleanup/backlog monitoring; alert delivery and incident contact; reverse-proxy rate-limit/capacity check; run one real end-to-end audit and erasure on staging | Operator |

Local development/testing can continue now with disposable accounts. Inviting a small group does not remove the need to settle personal-data handling. Email is optional only if an explicit, tested manual recovery/support process is accepted; the existing email UI must not leave testers expecting undeliverable mail.

## Public launch — additional blockers

- Complete and exercise self-service onboarding, email delivery/recovery and verification with a real provider/domain and failure handling; make account erasure easy to find and use.
- Final review of legal terms against actual business, hosting, data flows, retention, pro offerings and support practices; no invented registration/VAT details.
- Load/abuse tests, scanner isolation acceptance for the exact production bundle, rate-limit strategy beyond a single process, incident response, ongoing dependency/security review and monitored retention deadlines.
- If selling pro: billing/payment/plan lifecycle and matching public retention terms. An internal pro policy is not a launched paid plan. Postgres is a scaling decision, not automatically a launch prerequisite for a single-VM SQLite service.

## Actions needed personally from the owner

1. Review the draft PR and approve the chosen branch. Main remains unchanged; do not deploy until the gates above have evidence.
2. Choose the real domain/hosting/operator details and put them in the private deployment configuration (not a public PR).
3. Approve retention durations/erasure expectations for the unresolved categories and whether pro is part of the beta; confirm the existing free/account policy or request a change.
4. Choose a real email provider/sender or explicitly approve a workable manual beta support/provisioning process; name the person responsible for requests and incidents.
5. Arrange server access and staging acceptance, backups/restore and final legal review. The Mac audit cannot supply those facts or certify server behavior.

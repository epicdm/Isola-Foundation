"""The server-side allowlist — independent of Node's own check.

Test category mapping (see PR description for the full matrix):
  3. Tenant refusal (sidecar side)
  4. Template refusal
  5. Exposure refusal

Central property after the Codex review: the tenant is chosen by the
sidecar's OWN configuration. The envelope may only match it, never select it.
"""

from agentos_runtime.allowlist import (
    AGENTOS_ALLOWED_EXPOSURE,
    AGENTOS_ALLOWED_TEMPLATE_ID,
    AGENTOS_ALLOWED_TENANT,
    evaluate_eligibility,
)

CONFIGURED = AGENTOS_ALLOWED_TENANT


def test_exact_match_is_eligible():
    result = evaluate_eligibility(
        tenant_id=CONFIGURED,
        template_id=AGENTOS_ALLOWED_TEMPLATE_ID,
        exposure=AGENTOS_ALLOWED_EXPOSURE,
        configured_tenant_id=CONFIGURED,
    )
    assert result.eligible is True
    assert result.reason is None


def test_regression_forged_tenant_cannot_select_a_tenant_the_sidecar_is_not_configured_for():
    # The Codex finding, mirrored on the Python side. The sidecar is configured
    # for some OTHER tenant; the envelope carries the historically-allowlisted
    # constant. Before the fix this matched that constant and was admitted.
    result = evaluate_eligibility(
        tenant_id=AGENTOS_ALLOWED_TENANT,
        template_id=AGENTOS_ALLOWED_TEMPLATE_ID,
        exposure=AGENTOS_ALLOWED_EXPOSURE,
        configured_tenant_id="a-different-configured-tenant",
    )
    assert result.eligible is False
    assert "tenant_refused" in result.reason


def test_wrong_tenant_is_refused():
    result = evaluate_eligibility(
        tenant_id="some-other-tenant",
        template_id=AGENTOS_ALLOWED_TEMPLATE_ID,
        exposure=AGENTOS_ALLOWED_EXPOSURE,
        configured_tenant_id=CONFIGURED,
    )
    assert result.eligible is False
    assert "tenant_refused" in result.reason


def test_missing_tenant_is_refused():
    # Unlike the Node side (where an absent tenant means "the server supplies
    # it"), the envelope ALWAYS carries one by schema, so absent is malformed.
    result = evaluate_eligibility(
        tenant_id=None,
        template_id=AGENTOS_ALLOWED_TEMPLATE_ID,
        exposure=AGENTOS_ALLOWED_EXPOSURE,
        configured_tenant_id=CONFIGURED,
    )
    assert result.eligible is False
    assert "tenant_refused" in result.reason


def test_refusal_reason_never_echoes_either_tenant_value():
    # The reason string reaches an HTTP body and a log line. It must name the
    # rule, never the values being compared.
    forged = "forged-tenant-value-should-not-appear"
    result = evaluate_eligibility(
        tenant_id=forged,
        template_id=AGENTOS_ALLOWED_TEMPLATE_ID,
        exposure=AGENTOS_ALLOWED_EXPOSURE,
        configured_tenant_id=CONFIGURED,
    )
    assert result.eligible is False
    assert forged not in result.reason
    assert CONFIGURED not in result.reason


def test_wrong_template_is_refused():
    result = evaluate_eligibility(
        tenant_id=CONFIGURED,
        template_id="some-other-template@v1",
        exposure=AGENTOS_ALLOWED_EXPOSURE,
        configured_tenant_id=CONFIGURED,
    )
    assert result.eligible is False
    assert "template_refused" in result.reason


def test_wrong_exposure_is_refused():
    result = evaluate_eligibility(
        tenant_id=CONFIGURED,
        template_id=AGENTOS_ALLOWED_TEMPLATE_ID,
        exposure="PUBLIC",
        configured_tenant_id=CONFIGURED,
    )
    assert result.eligible is False
    assert "exposure_refused" in result.reason


def test_template_check_precedes_tenant_check():
    # Template refusal fires even when tenant is ALSO wrong — the reason names
    # the template, not the tenant, because a wrong template is the more
    # fundamental mismatch (this sidecar serves exactly one agent).
    result = evaluate_eligibility(
        tenant_id="nope",
        template_id="unknown@v1",
        exposure="PUBLIC",
        configured_tenant_id=CONFIGURED,
    )
    assert result.eligible is False
    assert "template_refused" in result.reason

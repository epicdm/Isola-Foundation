"""The server-side allowlist — independent of Node's own check.

Test category mapping (see PR description for the full 13-item matrix):
  3. Tenant refusal (sidecar side)
  4. Template refusal
  5. Exposure refusal
"""

from agentos_runtime.allowlist import (
    AGENTOS_ALLOWED_EXPOSURE,
    AGENTOS_ALLOWED_TEMPLATE_ID,
    AGENTOS_ALLOWED_TENANT,
    evaluate_eligibility,
)


def test_exact_match_is_eligible():
    result = evaluate_eligibility(
        tenant_id=AGENTOS_ALLOWED_TENANT,
        template_id=AGENTOS_ALLOWED_TEMPLATE_ID,
        exposure=AGENTOS_ALLOWED_EXPOSURE,
    )
    assert result.eligible is True
    assert result.reason is None


def test_wrong_tenant_is_refused():
    result = evaluate_eligibility(
        tenant_id="some-other-tenant",
        template_id=AGENTOS_ALLOWED_TEMPLATE_ID,
        exposure=AGENTOS_ALLOWED_EXPOSURE,
    )
    assert result.eligible is False
    assert "tenant_refused" in result.reason


def test_missing_tenant_is_refused():
    result = evaluate_eligibility(
        tenant_id=None,
        template_id=AGENTOS_ALLOWED_TEMPLATE_ID,
        exposure=AGENTOS_ALLOWED_EXPOSURE,
    )
    assert result.eligible is False
    assert "tenant_refused" in result.reason


def test_wrong_template_is_refused():
    result = evaluate_eligibility(
        tenant_id=AGENTOS_ALLOWED_TENANT,
        template_id="some-other-template@v1",
        exposure=AGENTOS_ALLOWED_EXPOSURE,
    )
    assert result.eligible is False
    assert "template_refused" in result.reason


def test_wrong_exposure_is_refused():
    result = evaluate_eligibility(
        tenant_id=AGENTOS_ALLOWED_TENANT,
        template_id=AGENTOS_ALLOWED_TEMPLATE_ID,
        exposure="PUBLIC",
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
    )
    assert result.eligible is False
    assert "template_refused" in result.reason

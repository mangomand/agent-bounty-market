import type { CreateBountyInput } from "./api/types";

export type BountyForm = {
  title: string;
  spec: string;
  testCommand: string;
  amountUsdc: string;
  /** Value of a datetime-local input, e.g. "2026-11-26T17:00". */
  deadline: string;
};

export type FormErrors = Partial<Record<keyof BountyForm, string>>;

/** Validates the post-bounty form. Returns errors, or the API input when valid. */
export function validateBounty(
  form: BountyForm,
  now = Date.now(),
): { ok: true; input: Omit<CreateBountyInput, "creator"> } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  const title = form.title.trim();
  const spec = form.spec.trim();
  const testCommand = form.testCommand.trim();
  const amount = form.amountUsdc.trim();

  if (!title) errors.title = "Required";
  else if (title.length > 120) errors.title = "120 characters max";
  if (!spec) errors.spec = "Required";
  if (!testCommand) errors.testCommand = "Required";
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) {
    errors.amountUsdc = "Enter a positive amount, up to 6 decimals";
  }
  const deadlineMs = form.deadline ? new Date(form.deadline).getTime() : NaN;
  if (!Number.isFinite(deadlineMs)) errors.deadline = "Required";
  else if (deadlineMs <= now) errors.deadline = "Must be in the future";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: { title, spec, testCommand, amountUsdc: amount, deadline: Math.floor(deadlineMs / 1000) },
  };
}

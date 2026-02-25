export type SecurityProfileName = "safe" | "full-control";

export type SecurityProfilePolicy = {
  name: SecurityProfileName;
  allowAiShell: boolean;
  allowReboot: boolean;
  forceApprovalMode: boolean;
};

function normalizeProfileName(input: string | undefined): SecurityProfileName {
  const normalized = (input ?? "").trim().toLowerCase();
  if (normalized === "full" || normalized === "full-control" || normalized === "full_control") {
    return "full-control";
  }
  return "safe";
}

export function resolveSecurityProfile(input: string | undefined): SecurityProfilePolicy {
  const name = normalizeProfileName(input);
  if (name === "full-control") {
    return {
      name,
      allowAiShell: true,
      allowReboot: true,
      forceApprovalMode: false,
    };
  }
  return {
    name,
    allowAiShell: false,
    allowReboot: false,
    forceApprovalMode: true,
  };
}

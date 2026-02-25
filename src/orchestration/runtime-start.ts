export async function startRuntimeServices(params: {
  startLocalBridgeServer: () => Promise<void>;
  onLocalBridgeStartError: (errorMessage: string) => void;
  startOutboxRecoveryWorker: () => void;
  startIntentHardNegativeWorker: () => void;
  startIntentCanaryGuardWorker: () => void;
  logInfo: (message: string) => void;
  startBot: () => Promise<void>;
}): Promise<void> {
  try {
    await params.startLocalBridgeServer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.onLocalBridgeStartError(message);
  }

  params.startOutboxRecoveryWorker();
  params.startIntentHardNegativeWorker();
  params.startIntentCanaryGuardWorker();
  params.logInfo("Starting Telegram bot...");
  await params.startBot();
}

export type ScheduledTaskStatus = "pending" | "done" | "canceled";
export type ScheduledTaskDeliveryKind = "reminder" | "gmail-send";

export type ScheduledTask = {
  id: string;
  chatId: number;
  userId?: number;
  title: string;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  status: ScheduledTaskStatus;
  completedAt?: string;
  canceledAt?: string;
  failureCount: number;
  lastError?: string;
  retryAfter?: string;
  deliveryKind?: ScheduledTaskDeliveryKind;
  deliveryPayload?: string;
};

export type CreateScheduledTaskInput = {
  chatId: number;
  userId?: number;
  title: string;
  dueAt: Date;
  deliveryKind?: ScheduledTaskDeliveryKind;
  deliveryPayload?: string;
};

export type UpdateScheduledTaskInput = {
  title?: string;
  dueAt?: Date;
};

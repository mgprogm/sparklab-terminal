import { z } from "zod";

/** Schema for the demo greeting form. */
export const greetingFormSchema = z.object({
  name: z.string().min(1, "Name is required").max(50, "Name is too long"),
  message: z.string().min(1, "Message is required"),
});

export type GreetingFormValues = z.infer<typeof greetingFormSchema>;

"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@sparklab/ui/components/ui/button";
import { Input } from "@sparklab/ui/components/ui/input";
import { Label } from "@sparklab/ui/components/ui/label";
import { useForm } from "react-hook-form";

import {
  greetingFormSchema,
  type GreetingFormValues,
} from "@/features/demo/schemas";
import { useDemoStore } from "@/features/demo/store";

export function DemoForm() {
  const lastGreeting = useDemoStore((s) => s.lastGreeting);
  const setLastGreeting = useDemoStore((s) => s.setLastGreeting);

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<GreetingFormValues>({
    resolver: zodResolver(greetingFormSchema),
    defaultValues: { name: "", message: "" },
  });

  const onSubmit = (data: GreetingFormValues) => {
    const greeting = `${data.message}, ${data.name}!`;
    setLastGreeting(greeting);
    reset();
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" placeholder="Enter your name" {...register("name")} />
        {errors.name && (
          <p className="text-destructive text-sm">{errors.name.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="message">Message</Label>
        <Input
          id="message"
          placeholder="Enter a greeting"
          {...register("message")}
        />
        {errors.message && (
          <p className="text-destructive text-sm">{errors.message.message}</p>
        )}
      </div>

      <Button type="submit" className="w-full">
        Submit
      </Button>

      {lastGreeting && (
        <div className="bg-muted rounded-md border p-3 text-center text-sm">
          {lastGreeting}
        </div>
      )}
    </form>
  );
}

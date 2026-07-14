import { DemoForm } from "@/features/demo/components/demo-form";

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold tracking-tight">
            Sparklab Platform
          </h1>
          <p className="text-muted-foreground text-sm">
            Pattern exemplar: query-key factory + RHF + Zod + Zustand
          </p>
        </div>
        <DemoForm />
      </div>
    </main>
  );
}

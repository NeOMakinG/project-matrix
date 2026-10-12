import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { endpoints } from "@/api/endpoints";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";

export const newProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "At least 2 characters")
    .max(40, "At most 40 characters")
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Lowercase letters, digits and dashes"),
  description: z.string().trim().max(200, "At most 200 characters"),
  workspace: z.enum(["orca", "native"]),
});

export function NewProjectPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: async (input: z.infer<typeof newProjectSchema>) => {
      const project = await endpoints.createProject(input);
      const session = await endpoints.startInit(project.id);
      return { project, session };
    },
    onSuccess: ({ project, session }) => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      void navigate({
        to: "/p/$projectId/init",
        params: { projectId: project.id },
        search: { session: session.id },
      });
    },
  });
  const form = useForm({
    defaultValues: { name: "", description: "", workspace: "orca" as "orca" | "native" },
    validators: { onSubmit: newProjectSchema },
    onSubmit: async ({ value }) => {
      await create.mutateAsync(newProjectSchema.parse(value));
    },
  });

  return (
    <>
      <PageHeader
        title="New project"
        subtitle="Name it, then the init interview asks about the business, stack, hosting, design and process."
      />
      <Card className="max-w-xl px-5 py-5">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="name">
            {(field) => (
              <label className="block">
                <span className="text-label text-fg-secondary">Project name</span>
                <input
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="ledgerly"
                  className="mt-1 h-9 w-full rounded-control border border-border-strong bg-canvas px-3 font-mono text-body outline-none focus:border-accent"
                />
                <FieldError errors={field.state.meta.errors} />
              </label>
            )}
          </form.Field>
          <form.Field name="description">
            {(field) => (
              <label className="block">
                <span className="text-label text-fg-secondary">One-line description</span>
                <input
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="Invoicing for freelancers"
                  className="mt-1 h-9 w-full rounded-control border border-border-strong bg-canvas px-3 text-body outline-none focus:border-accent"
                />
                <FieldError errors={field.state.meta.errors} />
              </label>
            )}
          </form.Field>
          <form.Field name="workspace">
            {(field) => (
              <fieldset>
                <legend className="text-label text-fg-secondary">Where agents work</legend>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(
                    [
                      [
                        "orca",
                        "Orca worktrees",
                        "Runs appear in Orca; you can watch and take over.",
                      ],
                      [
                        "native",
                        "Matrix containers",
                        "Worktrees and Podman containers managed by Matrix.",
                      ],
                    ] as const
                  ).map(([value, label, hint]) => (
                    <label
                      key={value}
                      className={cn(
                        "cursor-pointer rounded-card border px-3 py-2.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-offset-2",
                        field.state.value === value
                          ? "border-accent bg-accent-dim/40"
                          : "border-border-subtle bg-raised hover:border-border-strong",
                      )}
                    >
                      <input
                        type="radio"
                        name="workspace"
                        className="sr-only"
                        checked={field.state.value === value}
                        onChange={() => field.handleChange(value)}
                      />
                      <span className="block text-heading text-fg">{label}</span>
                      <span className="mt-0.5 block text-caption text-fg-secondary">{hint}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </form.Field>
          {create.isError ? (
            <p role="alert" className="text-caption text-danger">
              Couldn't create the project: {create.error.message}
            </p>
          ) : null}
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(submitting) => (
              <Button type="submit" variant="primary" disabled={submitting}>
                Create and start the interview
              </Button>
            )}
          </form.Subscribe>
        </form>
      </Card>
    </>
  );
}

function FieldError({ errors }: { errors: unknown[] }) {
  const first = errors[0];
  if (!first) return null;
  const message = typeof first === "string" ? first : (first as { message?: string }).message;
  return (
    <span role="alert" className="mt-1 block text-caption text-danger">
      {message ?? "Invalid value"}
    </span>
  );
}

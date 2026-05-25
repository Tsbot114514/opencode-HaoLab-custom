const pagePath = {
  classic: "/classic",
  manager: "/manager",
} as const

export default {
  description:
    "Dispatch a session-scoped frontend navigation request. Use this when the user asks to switch the visible desktop page between classic and manager. Pass arguments as top-level fields, for example {\"page\":\"manager\"}; do not wrap them in a properties object.",
  args: {
    type: "object",
    properties: {
      page: {
        type: "string",
        enum: ["classic", "manager"],
        description: "The frontend page to switch to.",
      },
      reason: {
        type: "string",
        description: "Short reason for the navigation request.",
      },
    },
    required: ["page"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const page = args.page as keyof typeof pagePath
    const request = {
      version: 1,
      type: "frontend.navigate",
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      agent: ctx.agent,
      directory: ctx.directory,
      worktree: ctx.worktree,
      page,
      path: pagePath[page],
      reason: typeof args.reason === "string" ? args.reason : "",
      createdAt: new Date().toISOString(),
    }

    return {
      title: "Frontend Dispatch",
      output: `Requested navigation to ${request.path}`,
      metadata: request,
    }
  },
}

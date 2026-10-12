import { Activity, BookOpen, KanbanSquare, MessagesSquare, Play, Settings } from "lucide-react";

export const PROJECT_SCREENS = [
  { label: "Board", to: "/p/$projectId/board", icon: KanbanSquare },
  { label: "Runs", to: "/p/$projectId/runs", icon: Play },
  { label: "Init interview", to: "/p/$projectId/init", icon: MessagesSquare },
  { label: "Knowledge", to: "/p/$projectId/knowledge", icon: BookOpen },
  { label: "Prod monitor", to: "/p/$projectId/monitor", icon: Activity },
  { label: "Settings", to: "/p/$projectId/settings", icon: Settings },
] as const;

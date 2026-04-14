import path from "path";

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "/home/user";

export const PATHS = {
  metaDir: process.env.GOVINUITY_META_DIR ?? path.join(process.cwd(), "data"),
  memoryDir: process.env.GOVINUITY_MEMORY_DIR ?? path.join(HOME, ".claude", "memory"),
};

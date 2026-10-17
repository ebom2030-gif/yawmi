import { onRequestGet as __api_index_js_onRequestGet } from "/home/claude/yawmi/functions/api/index.js"
import { onRequestPost as __api_index_js_onRequestPost } from "/home/claude/yawmi/functions/api/index.js"

export const routes = [
    {
      routePath: "/api",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_index_js_onRequestGet],
    },
  {
      routePath: "/api",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_index_js_onRequestPost],
    },
  ]
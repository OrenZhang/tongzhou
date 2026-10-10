{
  "targets": [
    {
      "target_name": "computer_x11",
      "sources": ["computer_x11.c"],
      "libraries": ["-lX11", "-lXtst"],
      "defines": ["NAPI_VERSION=8"],
    },
  ],
}

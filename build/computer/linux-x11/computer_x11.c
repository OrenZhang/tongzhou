/*
 * Tongzhou Linux computer control (X11/XWayland).
 *
 * N-API is ABI-stable: this addon is built once against Node headers and
 * loads in the Electron main process without a per-version rebuild.
 * Window enumeration, focus and input go through libX11/libXtst; the same
 * security contract as the Windows/macOS helpers applies (the TypeScript
 * side still owns one-shot frames, coordinate mapping and stale-window
 * checks).
 */
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XTest.h>
#include <X11/keysym.h>
#include <node_api.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void dbg(const char* format, ...) {
  if (!getenv("TONGZHOU_X11_DEBUG")) return;
  va_list args;
  va_start(args, format);
  vfprintf(stderr, format, args);
  va_end(args);
  fputc('\n', stderr);
}

static Display* display = NULL;
static int x_error_code = 0;
static int wslg_cached = -1;

/*
 * WSLg's compositor owns keyboard focus: XSetInputFocus and EWMH activation are
 * ignored and XTest key events are dropped. Synthetic XSendEvent keys still
 * reach XWayland clients there. Real X11 desktops keep the XTest path (accepted
 * by every toolkit) and require a focused window. On Wayland sessions even
 * outside WSLg, XTest keys pass through the IME (ibus/fcitx) and come out
 * transformed, so XWayland clients use synthetic keys as well.
 */
static int wslg(void) {
  if (wslg_cached < 0)
    wslg_cached = getenv("WSL_DISTRO_NAME") != NULL || access("/mnt/wslg", F_OK) == 0;
  return wslg_cached;
}

static int synthetic_keys(void) {
  static int cached = -1;
  if (cached < 0) {
    const char* force = getenv("TONGZHOU_X11_SYNTHETIC_KEYS");
    if (force)
      cached = atoi(force) != 0;
    else
      cached = wslg() || getenv("XDG_SESSION_TYPE") != NULL &&
                           strcmp(getenv("XDG_SESSION_TYPE"), "wayland") == 0;
  }
  return cached;
}

static int handle_x_error(Display* d, XErrorEvent* event) {
  (void)d;
  x_error_code = event->error_code;
  return 0;
}

/*
 * Earlier runs (or other clients) may have left Unicode keysyms on spare
 * keycodes. Clients that cached their keymap then disagree with the server, so
 * clear the Unicode private range on startup and after every typed character.
 */
static void clear_stale_unicode_keysyms(void);
static napi_value ok_result(napi_env env);

static Display* open_display(void) {
  if (!display) {
    display = XOpenDisplay(NULL);
    if (display) {
      XSetErrorHandler(handle_x_error);
      clear_stale_unicode_keysyms();
    }
  }
  return display;
}

static void clear_stale_unicode_keysyms(void) {
  if (!display) return;
  int min = 0, max = 0;
  XDisplayKeycodes(display, &min, &max);
  int per = 0;
  KeySym* mapping = XGetKeyboardMapping(display, min, max - min + 1, &per);
  if (!mapping) return;
  for (int code = min; code <= max; code++) {
    if ((mapping[(code - min) * per] & 0xff000000) == 0x01000000) {
      KeySym none = NoSymbol;
      XChangeKeyboardMapping(display, code, 1, &none, 1);
    }
  }
  XFree(mapping);
  XSync(display, False);
}

static int sync_ok(void) {
  x_error_code = 0;
  XSync(display, False);
  return x_error_code == 0;
}

static napi_value fail(napi_env env, const char* message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

static Window parse_window(napi_env env, napi_value value, Bool* ok) {
  char buffer[32];
  size_t length = 0;
  *ok = napi_get_value_string_utf8(env, value, buffer, sizeof(buffer), &length) == napi_ok &&
        length > 0;
  return *ok ? (Window)strtoul(buffer, NULL, 10) : 0;
}

static unsigned long window_pid(Window window) {
  Atom pid_atom = XInternAtom(display, "_NET_WM_PID", True);
  Atom actual;
  int format;
  unsigned long count, after;
  unsigned char* data = NULL;
  unsigned long pid = 0;
  if (pid_atom &&
      XGetWindowProperty(display, window, pid_atom, 0, 1, False, XA_CARDINAL, &actual, &format,
                         &count, &after, &data) == Success &&
      data) {
    if (format == 32 && count >= 1) pid = ((unsigned long*)data)[0];
    XFree(data);
  }
  return pid;
}

static int check_window(napi_env env, Window window, unsigned long expected_pid) {
  if (!sync_ok()) {
    napi_throw_error(env, NULL, "Window has changed or closed");
    return -1;
  }
  unsigned long pid = window_pid(window);
  if (!sync_ok()) {
    napi_throw_error(env, NULL, "Window has changed or closed");
    return -1;
  }
  if (expected_pid && pid != expected_pid) {
    napi_throw_error(env, NULL, "Window has changed");
    return -1;
  }
  return 0;
}

static int focus_window(napi_env env, Window window, int required) {
  Window root = DefaultRootWindow(display);
  /*
   * WSLg's compositor owns keyboard focus and reverts client-side focus
   * requests (XSetInputFocus / EWMH activation), so touching it only makes
   * things worse. There, verify that the window already has focus.
   */
  if (wslg()) {
    for (int attempt = 0; attempt < 4; attempt++) {
      if (!sync_ok()) {
        napi_throw_error(env, NULL, "Window has changed or closed");
        return -1;
      }
      Window focused = 0;
      int revert = 0;
      XGetInputFocus(display, &focused, &revert);
      if (focused == window) return 0;
      usleep(120000);
    }
    dbg("window has no keyboard focus (WSLg owns focus)");
    napi_throw_error(env, NULL, "Could not focus the selected window");
    return -1;
  }
  Atom active = XInternAtom(display, "_NET_ACTIVE_WINDOW", False);
  /* With a reparenting WM (e.g. WSLg/Weston) the frame must be raised too. */
  Window frame = window;
  Window root_return, parent = 0, *children = NULL;
  unsigned int count = 0;
  if (XQueryTree(display, window, &root_return, &parent, &children, &count) && children)
    XFree(children);
  if (parent && parent != root) frame = parent;
  for (int attempt = 0; attempt < 4; attempt++) {
    XClientMessageEvent event;
    memset(&event, 0, sizeof(event));
    event.type = ClientMessage;
    event.window = window;
    event.message_type = active;
    event.format = 32;
    event.data.l[0] = 2; /* direct application request */
    XSendEvent(display, root, False, SubstructureRedirectMask | SubstructureNotifyMask,
               (XEvent*)&event);
    if (frame != window) XRaiseWindow(display, frame);
    XRaiseWindow(display, window);
    XSetInputFocus(display, window, RevertToParent, CurrentTime);
    if (!sync_ok()) {
      napi_throw_error(env, NULL, "Window has changed or closed");
      return -1;
    }
    Window focused = 0;
    int revert = 0;
    XGetInputFocus(display, &focused, &revert);
    dbg("focus attempt=%d focused=%lu target=%lu", attempt, (unsigned long)focused,
        (unsigned long)window);
    if (focused == window) return 0;
    usleep(80000);
  }
  /*
   * WSLg's compositor owns keyboard focus and ignores both XSetInputFocus and
   * EWMH activation requests, so keyboard input is refused instead of silently
   * dropped. Pointer actions remain available (XTest pointer events need no
   * focus).
   */
  if (required) {
    dbg("focus unavailable (compositor-owned?)");
    napi_throw_error(env, NULL, "Could not focus the selected window");
    return -1;
  }
  return 0;
}

/* ---------- window enumeration ---------- */

typedef struct {
  Window id;
  char* title;
  unsigned long pid;
  Window owner;
  char class_name[128];
  int iconic;
  int x, y, width, height;
} WindowEntry;

static char* window_title(Window window) {
  Atom name_atom = XInternAtom(display, "_NET_WM_NAME", True);
  Atom utf8 = XInternAtom(display, "UTF8_STRING", True);
  if (name_atom && utf8) {
    Atom actual;
    int format;
    unsigned long count, after;
    unsigned char* data = NULL;
    if (XGetWindowProperty(display, window, name_atom, 0, 2048, False, utf8, &actual, &format,
                           &count, &after, &data) == Success &&
        data) {
      char* title = strndup((char*)data, count);
      XFree(data);
      if (title && title[0]) return title;
      free(title);
    }
  }
  char* legacy = NULL;
  if (XFetchName(display, window, &legacy) && legacy) {
    if (legacy[0]) return legacy;
    XFree(legacy);
  }
  return NULL;
}

static int is_iconic(Window window) {
  Atom state_atom = XInternAtom(display, "WM_STATE", True);
  if (!state_atom) return 0;
  Atom actual;
  int format;
  unsigned long count, after;
  unsigned char* data = NULL;
  int iconic = 0;
  if (XGetWindowProperty(display, window, state_atom, 0, 1, False, AnyPropertyType, &actual,
                         &format, &count, &after, &data) == Success &&
      data) {
    if (format == 32 && count >= 1 && ((unsigned long*)data)[0] == 3 /* IconicState */)
      iconic = 1;
    XFree(data);
  }
  return iconic;
}

static void json_escape(char** out, size_t* remaining, const char* text) {
  for (const unsigned char* p = (const unsigned char*)text; *p && *remaining > 8; p++) {
    if (*p == '"' || *p == '\\') {
      *(*out)++ = '\\';
      *(*out)++ = *p;
      *remaining -= 2;
    } else if (*p >= 0x20 && *p != 0x7f) {
      *(*out)++ = *p;
      *remaining -= 1;
    }
  }
}

static void collect_windows(Window window, Window root, WindowEntry* entries, size_t* used,
                            size_t capacity) {
  if (*used >= capacity) return;
  if (window != root) {
    XWindowAttributes attributes;
    if (XGetWindowAttributes(display, window, &attributes) &&
        attributes.map_state == IsViewable && !attributes.override_redirect) {
      char* title = window_title(window);
      if (title) {
        int x = 0, y = 0;
        Window child;
        XTranslateCoordinates(display, window, root, 0, 0, &x, &y, &child);
        if (attributes.width > 0 && attributes.height > 0) {
          WindowEntry* entry = &entries[(*used)++];
          entry->id = window;
          entry->title = title;
          entry->pid = window_pid(window);
          entry->owner = 0;
          XGetTransientForHint(display, window, &entry->owner);
          entry->class_name[0] = 0;
          XClassHint hint;
          if (XGetClassHint(display, window, &hint)) {
            if (hint.res_class) {
              snprintf(entry->class_name, sizeof(entry->class_name), "%s", hint.res_class);
              XFree(hint.res_class);
            }
            if (hint.res_name) XFree(hint.res_name);
          }
          entry->iconic = is_iconic(window);
          entry->x = x;
          entry->y = y;
          entry->width = attributes.width;
          entry->height = attributes.height;
        } else {
          free(title);
        }
      }
    }
  }
  Window root_return, parent, *children = NULL;
  unsigned int count = 0;
  if (XQueryTree(display, window, &root_return, &parent, &children, &count) && children) {
    for (unsigned int i = 0; i < count; i++)
      collect_windows(children[i], root, entries, used, capacity);
    XFree(children);
  }
}

static napi_value list_windows(napi_env env, napi_callback_info info) {
  (void)info;
  if (!open_display()) return fail(env, "X11 display is not available");
  Window root = DefaultRootWindow(display);
  WindowEntry* entries = calloc(200, sizeof(WindowEntry));
  size_t used = 0;
  collect_windows(root, root, entries, &used, 200);
  if (!sync_ok()) {
    for (size_t i = 0; i < used; i++) free(entries[i].title);
    free(entries);
    return fail(env, "X11 window enumeration failed");
  }

  size_t capacity = 1 << 20;
  char* json = malloc(capacity);
  size_t off = 0;
  json[off++] = '[';
  int first = 1;
  for (size_t i = 0; i < used && capacity - off > 1024; i++) {
    WindowEntry* entry = &entries[i];
    if (entry->iconic) continue;
    int blocked = 0;
    for (size_t j = 0; j < used; j++)
      if (entries[j].owner == entry->id) blocked = 1;
    size_t remaining = capacity - off;
    int written = snprintf(json + off, remaining, "%s{\"id\":\"%lu\",\"title\":\"",
                           first ? "" : ",", (unsigned long)entry->id);
    if (written < 0 || (size_t)written >= remaining) break;
    off += (size_t)written;
    remaining = capacity - off;
    char* cursor = json + off;
    json_escape(&cursor, &remaining, entry->title);
    off = (size_t)(cursor - json);
    remaining = capacity - off;
    written = snprintf(json + off, remaining,
                       "\",\"pid\":%lu,\"ownerId\":\"%lu\",\"className\":\"%s\",\"enabled\":%s,"
                       "\"bounds\":{\"x\":%d,\"y\":%d,\"width\":%d,\"height\":%d},"
                       "\"clientBounds\":{\"x\":%d,\"y\":%d,\"width\":%d,\"height\":%d}}",
                       entry->pid, (unsigned long)entry->owner, entry->class_name,
                       blocked ? "false" : "true", entry->x, entry->y, entry->width,
                       entry->height, entry->x, entry->y, entry->width, entry->height);
    if (written < 0 || (size_t)written >= remaining) break;
    off += (size_t)written;
    first = 0;
  }
  if (off > capacity - 2) off = capacity - 2;
  json[off++] = ']';
  json[off] = 0;
  for (size_t i = 0; i < used; i++) free(entries[i].title);
  free(entries);
  napi_value result;
  napi_create_string_utf8(env, json, NAPI_AUTO_LENGTH, &result);
  free(json);
  return result;
}

/* ---------- capture ---------- */

/*
 * Wayland sessions (WAYLAND_DISPLAY + XDG_SESSION_TYPE both set) route
 * Chromium's desktopCapturer to the portal path, which exposes no window
 * sources. Read the window's pixels straight from the X server instead, on
 * the same connection as enumeration and input. The image is capped (aspect
 * preserved, never upscaled) to match the desktopCapturer thumbnail size the
 * TypeScript side uses elsewhere.
 */
static unsigned int mask_shift(unsigned long mask) {
  unsigned int shift = 0;
  while (mask && !(mask & 1)) {
    mask >>= 1;
    shift++;
  }
  return shift;
}

static unsigned int mask_max(unsigned long mask, unsigned int shift) {
  return mask ? (unsigned int)(mask >> shift) : 0;
}

static unsigned char mask_byte(unsigned long pixel, unsigned long mask, unsigned int shift) {
  unsigned int max = mask_max(mask, shift);
  if (!max) return 0;
  unsigned int raw = (unsigned int)((pixel & mask) >> shift);
  return (unsigned char)((raw * 255 + max / 2) / max);
}

static napi_value capture_window(napi_env env, napi_value args_info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, args_info, &argc, argv, NULL, NULL);
  if (!open_display()) return fail(env, "X11 display is not available");
  Bool ok = 0;
  Window window = parse_window(env, argv[0], &ok);
  int32_t pid = 0;
  napi_get_value_int32(env, argv[1], &pid);
  if (!ok) return fail(env, "bad window id");
  if (check_window(env, window, (unsigned long)pid) < 0) return NULL;
  XWindowAttributes attributes;
  if (!XGetWindowAttributes(display, window, &attributes) ||
      attributes.map_state != IsViewable || attributes.width <= 0 || attributes.height <= 0)
    return fail(env, "Window is not viewable");
  int width = attributes.width;
  int height = attributes.height;
  int target_width = width;
  int target_height = height;
  if (target_width > 1280) {
    target_height = (int)((long)target_height * 1280 / target_width);
    target_width = 1280;
  }
  if (target_height > 960) {
    target_width = (int)((long)target_width * 960 / target_height);
    target_height = 960;
  }
  if (target_width < 1) target_width = 1;
  if (target_height < 1) target_height = 1;
  XImage* image = XGetImage(display, window, 0, 0, width, height, AllPlanes, ZPixmap);
  if (!image) return fail(env, "XGetImage failed for the selected window");
  unsigned int red_shift = mask_shift(image->red_mask);
  unsigned int green_shift = mask_shift(image->green_mask);
  unsigned int blue_shift = mask_shift(image->blue_mask);
  size_t pixels = (size_t)target_width * target_height;
  unsigned char* rgba = malloc(pixels * 4);
  if (!rgba) {
    XDestroyImage(image);
    return fail(env, "out of memory");
  }
  /* Box-average downscale: every source pixel is visited exactly once. */
  for (int dy = 0; dy < target_height; dy++) {
    int y0 = (int)((long)dy * height / target_height);
    int y1 = (int)((long)(dy + 1) * height / target_height);
    if (y1 <= y0) y1 = y0 + 1;
    for (int dx = 0; dx < target_width; dx++) {
      int x0 = (int)((long)dx * width / target_width);
      int x1 = (int)((long)(dx + 1) * width / target_width);
      if (x1 <= x0) x1 = x0 + 1;
      unsigned long red = 0, green = 0, blue = 0, count = 0;
      for (int sy = y0; sy < y1 && sy < height; sy++) {
        for (int sx = x0; sx < x1 && sx < width; sx++) {
          unsigned long pixel = XGetPixel(image, sx, sy);
          red += mask_byte(pixel, image->red_mask, red_shift);
          green += mask_byte(pixel, image->green_mask, green_shift);
          blue += mask_byte(pixel, image->blue_mask, blue_shift);
          count++;
        }
      }
      if (!count) count = 1;
      size_t offset = ((size_t)dy * target_width + dx) * 4;
      rgba[offset] = (unsigned char)(red / count);
      rgba[offset + 1] = (unsigned char)(green / count);
      rgba[offset + 2] = (unsigned char)(blue / count);
      rgba[offset + 3] = 255;
    }
  }
  XDestroyImage(image);
  if (!sync_ok()) {
    free(rgba);
    return fail(env, "Window has changed or closed");
  }
  napi_value data, width_value, height_value, result;
  napi_create_buffer_copy(env, pixels * 4, rgba, NULL, &data);
  free(rgba);
  napi_create_int32(env, target_width, &width_value);
  napi_create_int32(env, target_height, &height_value);
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "data", data);
  napi_set_named_property(env, result, "width", width_value);
  napi_set_named_property(env, result, "height", height_value);
  return result;
}

/* ---------- input ---------- */

static void move_pointer(int x, int y) {
  XTestFakeMotionEvent(display, DefaultScreen(display), x, y, CurrentTime);
  XSync(display, False);
  usleep(5000);
}

static void button_event(unsigned int button, Bool pressed) {
  XTestFakeButtonEvent(display, button, pressed, CurrentTime);
  XSync(display, False);
  usleep(5000);
}

static void key_event(KeyCode code, Bool pressed) {
  XTestFakeKeyEvent(display, code, pressed, CurrentTime);
  XSync(display, False);
  usleep(2000);
}

/* Synthetic core key events delivered straight to the target window. */
static void synthetic_raw(Window window, KeyCode code, unsigned int state, Bool pressed) {
  XKeyEvent event;
  memset(&event, 0, sizeof(event));
  event.display = display;
  event.window = window;
  event.root = DefaultRootWindow(display);
  event.subwindow = None;
  event.time = CurrentTime;
  event.x = event.y = event.x_root = event.y_root = 1;
  event.same_screen = True;
  event.keycode = code;
  event.state = state;
  event.type = pressed ? KeyPress : KeyRelease;
  XSendEvent(display, window, True, pressed ? KeyPressMask : KeyReleaseMask, (XEvent*)&event);
  XSync(display, False);
  usleep(8000);
}

static void synthetic_key(Window window, KeyCode code, unsigned int state) {
  synthetic_raw(window, code, state, True);
  synthetic_raw(window, code, state, False);
}

static void send_key(Window window, KeyCode code, unsigned int state) {
  if (synthetic_keys())
    synthetic_key(window, code, state);
  else
    key_event(code, True), key_event(code, False);
}

/* ---------- clipboard-based typing ----------
 *
 * Keystroke injection cannot type arbitrary Unicode reliably on X11: XTest
 * keys pass through the desktop IME (ibus/fcitx) and come back transformed,
 * and keymap remapping (XChangeKeyboardMapping) is not reflected in the XKB
 * map that XWayland clients actually consult. Desktop IMEs pass Ctrl+V
 * through untransformed, so typing is a genuine paste.
 *
 * The paste is orchestrated from TypeScript in event-loop ticks: save the
 * current clipboard, publish the text as the CLIPBOARD selection, send
 * Ctrl+V to the focused window, serve the fetch, then release. The main
 * thread must breathe between ticks: the paste target (a Chromium renderer)
 * asks its own browser process for the clipboard over IPC, which can only
 * be served while the addon is not blocking the event loop — including when
 * the current clipboard owner is this very app.
 */

static Window clip_window = 0;
static Atom clip_clipboard = 0;
static Atom clip_utf8 = 0;
static Atom clip_string = 0;
static Atom clip_targets = 0;
static Atom clip_text = 0;
static Atom clip_tz = 0;
static char* clip_data = NULL;
static size_t clip_length = 0;
static int clip_served = 0;
static int clip_read_state = 0; /* 0 idle, 1 pending, 2 done */
static char* clip_read_text = NULL;
static size_t clip_read_length = 0;

static void ensure_clip(void) {
  if (clip_window) return;
  clip_window = XCreateSimpleWindow(display, DefaultRootWindow(display), -10, -10, 1, 1, 0, 0, 0);
  clip_clipboard = XInternAtom(display, "CLIPBOARD", False);
  clip_utf8 = XInternAtom(display, "UTF8_STRING", False);
  clip_string = XInternAtom(display, "STRING", False);
  clip_targets = XInternAtom(display, "TARGETS", False);
  clip_text = XInternAtom(display, "TEXT", False);
  clip_tz = XInternAtom(display, "TZ_CLIPBOARD_READ", False);
}

/* Drain pending events without blocking: answer clipboard selection requests
 * and record the outcome of our own clipboard read. */
static void clip_drain(void) {
  if (!display) return;
  while (XPending(display)) {
    XEvent event;
    XNextEvent(display, &event);
    if (event.type == SelectionRequest) {
      XSelectionRequestEvent* request = &event.xselectionrequest;
      XSelectionEvent notify;
      memset(&notify, 0, sizeof(notify));
      notify.type = SelectionNotify;
      notify.display = display;
      notify.requestor = request->requestor;
      notify.selection = request->selection;
      notify.target = request->target;
      notify.time = request->time;
      notify.property = None;
      if (request->selection == clip_clipboard && clip_data) {
        if (request->target == clip_targets) {
          Atom list[] = {clip_targets, clip_utf8, clip_string, clip_text};
          XChangeProperty(display, request->requestor, request->property, XA_ATOM, 32,
                          PropModeReplace, (unsigned char*)list, 4);
          notify.property = request->property;
        } else if (request->target == clip_utf8 || request->target == clip_string ||
                   request->target == clip_text) {
          /* Only an actual data fetch counts as "served": requestors first
           * ask for TARGETS, and releasing right after that would race the
           * real conversion. */
          clip_served++;
          XChangeProperty(display, request->requestor, request->property, request->target, 8,
                          PropModeReplace, (unsigned char*)clip_data, (int)clip_length);
          notify.property = request->property;
        }
      }
      XSendEvent(display, request->requestor, False, NoEventMask, (XEvent*)&notify);
      XFlush(display);
    } else if (event.type == SelectionClear &&
               event.xselectionclear.selection == clip_clipboard) {
      free(clip_data);
      clip_data = NULL;
      clip_length = 0;
    } else if (event.type == SelectionNotify &&
               event.xselection.selection == clip_clipboard && clip_read_state == 1) {
      clip_read_state = 2;
      free(clip_read_text);
      clip_read_text = NULL;
      clip_read_length = 0;
      if (event.xselection.property == clip_tz) {
        Atom actual;
        int format;
        unsigned long count, after;
        unsigned char* data = NULL;
        if (XGetWindowProperty(display, clip_window, clip_tz, 0, 1 << 18, True, AnyPropertyType,
                               &actual, &format, &count, &after, &data) == Success && data) {
          clip_read_text = malloc(count + 1);
          memcpy(clip_read_text, data, count);
          clip_read_text[count] = 0;
          clip_read_length = count;
          XFree(data);
        }
      }
    }
  }
}

static napi_value clip_begin_read(napi_env env, napi_value info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (!open_display()) return fail(env, "X11 display is not available");
  ensure_clip();
  char target[16] = "utf8";
  size_t length = 0;
  napi_get_value_string_utf8(env, argv[0], target, sizeof(target), &length);
  Atom conversion = strcmp(target, "string") == 0 ? clip_string : clip_utf8;
  clip_read_state = 1;
  XDeleteProperty(display, clip_window, clip_tz);
  XConvertSelection(display, clip_clipboard, conversion, clip_tz, clip_window, CurrentTime);
  XFlush(display);
  return ok_result(env);
}

static napi_value clip_service(napi_env env, napi_value info) {
  (void)info;
  if (!open_display()) return fail(env, "X11 display is not available");
  clip_drain();
  napi_value result, read, served, text;
  napi_create_object(env, &result);
  const char* state = clip_read_state == 1 ? "pending" : clip_read_state == 2 ? "done" : "idle";
  napi_create_string_utf8(env, state, NAPI_AUTO_LENGTH, &read);
  napi_set_named_property(env, result, "read", read);
  napi_get_boolean(env, clip_served > 0, &served);
  napi_set_named_property(env, result, "served", served);
  if (clip_read_state == 2) {
    napi_create_string_utf8(env, clip_read_text ? clip_read_text : "",
                            clip_read_length, &text);
    napi_set_named_property(env, result, "text", text);
    free(clip_read_text);
    clip_read_text = NULL;
    clip_read_length = 0;
    clip_read_state = 0;
  }
  return result;
}

static napi_value clip_publish(napi_env env, napi_value info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (!open_display()) return fail(env, "X11 display is not available");
  ensure_clip();
  size_t length = 0;
  napi_get_value_string_utf8(env, argv[0], NULL, 0, &length);
  char* text = malloc(length + 1);
  napi_get_value_string_utf8(env, argv[0], text, length + 1, &length);
  free(clip_data);
  clip_data = text;
  clip_length = length;
  clip_served = 0;
  XSetSelectionOwner(display, clip_clipboard, clip_window, CurrentTime);
  XFlush(display);
  return ok_result(env);
}

static napi_value clip_release(napi_env env, napi_value info) {
  (void)env;
  (void)info;
  if (display && clip_window) XSetSelectionOwner(display, clip_clipboard, None, CurrentTime);
  free(clip_data);
  clip_data = NULL;
  clip_length = 0;
  clip_served = 0;
  return NULL;
}

static KeySym key_symbol(const char* name) {
  struct Entry {
    const char* name;
    KeySym sym;
  };
  static const struct Entry table[] = {
      {"CTRL", XK_Control_L},  {"SHIFT", XK_Shift_L},   {"ALT", XK_Alt_L},
      {"CMD", XK_Super_L},     {"ENTER", XK_Return},     {"TAB", XK_Tab},
      {"ESC", XK_Escape},      {"BACKSPACE", XK_BackSpace}, {"DELETE", XK_Delete},
      {"SPACE", XK_space},     {"LEFT", XK_Left},        {"RIGHT", XK_Right},
      {"UP", XK_Up},           {"DOWN", XK_Down},        {"HOME", XK_Home},
      {"END", XK_End},         {"PAGEUP", XK_Page_Up},   {"PAGEDOWN", XK_Page_Down},
  };
  for (size_t i = 0; i < sizeof(table) / sizeof(table[0]); i++)
    if (strcmp(name, table[i].name) == 0) return table[i].sym;
  if (name[0] == 'F' && name[1] >= '1' && name[1] <= '9' && !name[2])
    return XK_F1 + (name[1] - '1');
  if (name[0] == 'F' && name[1] == '1' && name[2] >= '0' && name[2] <= '2' && !name[3])
    return XK_F10 + (name[2] - '0');
  if (strlen(name) == 1) {
    char lower = name[0];
    if (lower >= 'A' && lower <= 'Z') lower += 32;
    char buffer[2] = {lower, 0};
    return XStringToKeysym(buffer);
  }
  return NoSymbol;
}

/* ---------- N-API actions ---------- */

static napi_value ok_result(napi_env env) {
  napi_value result;
  napi_create_string_utf8(env, "{\"ok\":true}", NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value activate(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (!open_display()) return fail(env, "X11 display is not available");
  Bool ok = 0;
  Window window = parse_window(env, argv[0], &ok);
  int32_t pid = 0;
  napi_get_value_int32(env, argv[1], &pid);
  if (!ok) return fail(env, "bad window id");
  if (check_window(env, window, pid) < 0) return NULL;
  if (focus_window(env, window, 1) < 0) return NULL;
  return ok_result(env);
}

static napi_value click(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value argv[6];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (!open_display()) return fail(env, "X11 display is not available");
  Bool ok = 0;
  Window window = parse_window(env, argv[0], &ok);
  int32_t pid = 0, x = 0, y = 0, count = 1;
  char button[8] = "left";
  size_t length = 0;
  napi_get_value_int32(env, argv[1], &pid);
  napi_get_value_int32(env, argv[2], &x);
  napi_get_value_int32(env, argv[3], &y);
  napi_get_value_string_utf8(env, argv[4], button, sizeof(button), &length);
  napi_get_value_int32(env, argv[5], &count);
  if (!ok) return fail(env, "bad window id");
  if (check_window(env, window, pid) < 0) return NULL;
  if (focus_window(env, window, 0) < 0) return NULL;
  unsigned int code = strcmp(button, "right") == 0 ? 3 : 1;
  move_pointer(x, y);
  for (int i = 0; i < count; i++) {
    button_event(code, True);
    button_event(code, False);
    usleep(30000);
  }
  if (!sync_ok()) return fail(env, "Window has changed or closed");
  return ok_result(env);
}

static napi_value paste_chord(napi_env env, napi_value info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (!open_display()) return fail(env, "X11 display is not available");
  Bool ok = 0;
  Window window = parse_window(env, argv[0], &ok);
  int32_t pid = 0;
  napi_get_value_int32(env, argv[1], &pid);
  if (!ok) return fail(env, "bad window id");
  if (check_window(env, window, pid) < 0) return NULL;
  if (focus_window(env, window, 1) < 0) return NULL;
  KeyCode ctrl = XKeysymToKeycode(display, XK_Control_L);
  KeyCode v = XKeysymToKeycode(display, 'v');
  if (synthetic_keys()) {
    synthetic_raw(window, ctrl, 0, True);
    usleep(10000);
    synthetic_raw(window, v, ControlMask, True);
    usleep(8000);
    synthetic_raw(window, v, ControlMask, False);
    usleep(8000);
    synthetic_raw(window, ctrl, 0, False);
  } else {
    key_event(ctrl, True);
    usleep(10000);
    key_event(v, True);
    usleep(8000);
    key_event(v, False);
    usleep(8000);
    key_event(ctrl, False);
  }
  if (!sync_ok()) return fail(env, "Window has changed or closed");
  return ok_result(env);
}

static napi_value press_key(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (!open_display()) return fail(env, "X11 display is not available");
  Bool ok = 0;
  Window window = parse_window(env, argv[0], &ok);
  int32_t pid = 0;
  char spec[64];
  size_t length = 0;
  napi_get_value_int32(env, argv[1], &pid);
  napi_get_value_string_utf8(env, argv[2], spec, sizeof(spec), &length);
  if (!ok) return fail(env, "bad window id");
  if (check_window(env, window, pid) < 0) return NULL;
  if (focus_window(env, window, 1) < 0) return NULL;
  char copy[64];
  snprintf(copy, sizeof(copy), "%s", spec);
  KeySym modifiers[4];
  int modifier_count = 0;
  char* save = NULL;
  char* part = strtok_r(copy, "+", &save);
  char* parts[8];
  int part_count = 0;
  while (part && part_count < 8) {
    parts[part_count++] = part;
    part = strtok_r(NULL, "+", &save);
  }
  if (!part_count) return fail(env, "Unknown action");
  for (int i = 0; i < part_count - 1; i++) {
    KeySym sym = key_symbol(parts[i]);
    if (!sym) return fail(env, "Unknown action");
    modifiers[modifier_count++] = sym;
  }
  KeySym main_sym = key_symbol(parts[part_count - 1]);
  if (!main_sym) return fail(env, "Unknown action");
  KeyCode code = XKeysymToKeycode(display, main_sym);
  if (wslg()) {
    /* Synthetic events carry modifier state directly; no key-state changes. */
    unsigned int state = 0;
    for (int i = 0; i < modifier_count; i++) {
      if (modifiers[i] == XK_Shift_L) state |= ShiftMask;
      else if (modifiers[i] == XK_Control_L) state |= ControlMask;
      else if (modifiers[i] == XK_Alt_L) state |= Mod1Mask;
      else if (modifiers[i] == XK_Super_L) state |= Mod4Mask;
    }
    synthetic_key(window, code, state);
  } else {
    for (int i = 0; i < modifier_count; i++)
      key_event(XKeysymToKeycode(display, modifiers[i]), True);
    key_event(code, True);
    key_event(code, False);
    for (int i = modifier_count - 1; i >= 0; i--)
      key_event(XKeysymToKeycode(display, modifiers[i]), False);
  }
  if (!sync_ok()) return fail(env, "Window has changed or closed");
  return ok_result(env);
}

static napi_value scroll(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (!open_display()) return fail(env, "X11 display is not available");
  Bool ok = 0;
  Window window = parse_window(env, argv[0], &ok);
  int32_t pid = 0, x = 0, y = 0, amount = 0;
  napi_get_value_int32(env, argv[1], &pid);
  napi_get_value_int32(env, argv[2], &x);
  napi_get_value_int32(env, argv[3], &y);
  napi_get_value_int32(env, argv[4], &amount);
  if (!ok) return fail(env, "bad window id");
  if (check_window(env, window, pid) < 0) return NULL;
  if (focus_window(env, window, 0) < 0) return NULL;
  move_pointer(x, y);
  unsigned int code = amount > 0 ? 5 : 4;
  int times = amount > 0 ? amount : -amount;
  if (times > 10) times = 10;
  for (int i = 0; i < times; i++) {
    button_event(code, True);
    button_event(code, False);
  }
  if (!sync_ok()) return fail(env, "Window has changed or closed");
  return ok_result(env);
}

static napi_value drag(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value argv[6];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (!open_display()) return fail(env, "X11 display is not available");
  Bool ok = 0;
  Window window = parse_window(env, argv[0], &ok);
  int32_t pid = 0, x = 0, y = 0, to_x = 0, to_y = 0;
  napi_get_value_int32(env, argv[1], &pid);
  napi_get_value_int32(env, argv[2], &x);
  napi_get_value_int32(env, argv[3], &y);
  napi_get_value_int32(env, argv[4], &to_x);
  napi_get_value_int32(env, argv[5], &to_y);
  if (!ok) return fail(env, "bad window id");
  if (check_window(env, window, pid) < 0) return NULL;
  if (focus_window(env, window, 0) < 0) return NULL;
  move_pointer(x, y);
  button_event(1, True);
  for (int step = 1; step <= 12; step++) {
    move_pointer(x + (to_x - x) * step / 12, y + (to_y - y) * step / 12);
    usleep(15000);
  }
  button_event(1, False);
  if (!sync_ok()) return fail(env, "Window has changed or closed");
  return ok_result(env);
}

static napi_value release_all(napi_env env, napi_callback_info info) {
  (void)info;
  if (!open_display()) return fail(env, "X11 display is not available");
  KeySym modifiers[] = {XK_Control_L, XK_Shift_L, XK_Alt_L, XK_Super_L};
  for (size_t i = 0; i < sizeof(modifiers) / sizeof(modifiers[0]); i++)
    key_event(XKeysymToKeycode(display, modifiers[i]), False);
  for (unsigned int button = 1; button <= 3; button++) button_event(button, False);
  XSync(display, False);
  return ok_result(env);
}

static napi_value available(napi_env env, napi_callback_info info) {
  (void)info;
  Display* probe = XOpenDisplay(NULL);
  int ok = probe != NULL;
  if (probe) XCloseDisplay(probe);
  napi_value result;
  napi_get_boolean(env, ok, &result);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  struct {
    const char* name;
    napi_callback fn;
  } methods[] = {
      {"available", available}, {"listWindows", list_windows}, {"activate", activate},
      {"click", click},         {"pasteChord", paste_chord},   {"pressKey", press_key},
      {"scroll", scroll},       {"drag", drag},                {"releaseAll", release_all},
      {"capture", capture_window}, {"clipBeginRead", clip_begin_read},
      {"clipService", clip_service}, {"clipPublish", clip_publish},
      {"clipRelease", clip_release},
  };
  for (size_t i = 0; i < sizeof(methods) / sizeof(methods[0]); i++) {
    napi_value fn;
    napi_create_function(env, methods[i].name, NAPI_AUTO_LENGTH, methods[i].fn, NULL, &fn);
    napi_set_named_property(env, exports, methods[i].name, fn);
  }
  return exports;
}

NAPI_MODULE(computer_x11, init)

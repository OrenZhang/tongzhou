// Executed by Apple's administrator authorization service. No sudoers changes or persistent daemon.
// All writable state is under a root-owned directory, never an application/user-supplied path.
export const macLidDirectory = '/var/run/org.tongzhou.power';
export const macLidScript = String.raw`
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
owner="$1"
token="$2"
mode="$3"
case "$owner" in ''|*[!0-9]*) exit 1;; esac
case "$token" in ''|*[!a-f0-9]*) exit 1;; esac
[ "$(id -u)" = 0 ] || exit 1
directory=/var/run/org.tongzhou.power
umask 022
if [ ! -e "$directory" ]; then mkdir -m 755 "$directory" || exit 1; fi
[ ! -L "$directory" ] || exit 1
[ "$(stat -f '%u %Lp' "$directory")" = '0 755' ] || exit 1
status() {
  printf '%s %s\n' "$token" "$1" > "$directory/status.tmp.$$"
  mv -f "$directory/status.tmp.$$" "$directory/status-$token"
}
stamp() { ps -p "$1" -o lstart=; }
if ! mkdir "$directory/lock" 2>/dev/null; then
  previous=$(cat "$directory/lock/pid" 2>/dev/null || true)
  previous_stamp=$(cat "$directory/lock/stamp" 2>/dev/null || true)
  if [ -z "$previous" ] || [ -z "$previous_stamp" ]; then
    status busy
    exit 1
  fi
  if [ -n "$previous" ] && [ -n "$previous_stamp" ] && [ "$(stamp "$previous")" = "$previous_stamp" ]; then
    status busy
    exit 1
  fi
  rm -f "$directory/lock/pid" "$directory/lock/stamp"
  rmdir "$directory/lock" 2>/dev/null || exit 1
  mkdir "$directory/lock" || exit 1
fi
printf '%s\n' "$$" > "$directory/lock/pid"
stamp "$$" > "$directory/lock/stamp"
read_sleep() {
  settings=$(/usr/bin/pmset -g) || return 1
  value=$(printf '%s\n' "$settings" | awk '$1 == "SleepDisabled" { print $2; found=1 } END { if (!found) print 0 }')
  case "$value" in 0|1) printf '%s\n' "$value";; *) return 1;; esac
}
restore() {
  [ -f "$directory/original" ] || return 0
  old=$(cat "$directory/original")
  case "$old" in 0|1) ;; *) return 1;; esac
  current=$(read_sleep) || return 1
  if [ "$current" = 1 ]; then /usr/bin/pmset -a disablesleep "$old" || return 1; fi
  current=$(read_sleep) || return 1
  [ "$current" = "$old" ] || [ "$current" = 0 ] || return 1
  rm -f "$directory/original"
}
finish() {
  trap - EXIT HUP INT TERM
  if restore; then status restored; else status restore-error; fi
  rm -f "$directory/lock/pid" "$directory/lock/stamp"
  rmdir "$directory/lock" 2>/dev/null || true
}
trap finish EXIT
trap 'exit 0' HUP INT TERM
restore || exit 1
[ "$mode" = recover ] && exit 0
owner_stamp=$(stamp "$owner")
[ -n "$owner_stamp" ] || exit 1
on_ac() {
  source=$(/usr/bin/pmset -g batt) || return 1
  case "$source" in *"'AC Power'"*) return 0;; *) return 1;; esac
}
on_ac || exit 1
original=$(read_sleep) || exit 1
printf '%s\n' "$original" > "$directory/original.tmp.$$"
mv -f "$directory/original.tmp.$$" "$directory/original"
/usr/bin/pmset -a disablesleep 1 || exit 1
[ "$(read_sleep)" = 1 ] || exit 1
status active
while [ "$(stamp "$owner")" = "$owner_stamp" ] && on_ac; do
  sleep 1
done
`;

export function macLidAuthorization(ownerPid: number, token: string, recover = false) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !/^[a-f0-9]{32}$/.test(token))
    throw new Error('无效的电源管理会话');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = `/bin/sh -c ${quote(macLidScript)} -- ${ownerPid} ${token} ${recover ? 'recover' : 'enable'} </dev/null >/dev/null 2>&1 &`;
  // AppleScript string syntax, separate from the POSIX shell quoting above.
  return (
    'do shell script "' +
    command.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n') +
    '" with administrator privileges'
  );
}

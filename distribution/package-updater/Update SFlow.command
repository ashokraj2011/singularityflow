#!/bin/bash
updater_folder="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bash "$updater_folder/update-sflow.sh" "$@"
updater_result=$?
if [[ -t 0 ]]; then
  printf '\nPress Return to close this window… '
  read -r updater_answer
fi
exit "$updater_result"

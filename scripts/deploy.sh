#!/usr/bin/env bash
# El plugin vivo es el checkout git del daemon (~/.paseo/plugins/paseo-archivadas/<id>/checkout, instalado con
# `paseo plugin add git:...`): desplegar = actualizar ese checkout desde el trunk del repo y recargar.
set -euo pipefail
id=$(node -p "require('./paseo-plugin.json').id")
checkout=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.paseo/config.json','utf8')).plugins?.[process.argv[1]]?.path ?? '')" "$id")
if [ -z "$checkout" ] || [ ! -d "$checkout" ]; then
  echo "paseo-archivadas no está instalado por git en el daemon: paseo plugin add git:pocharlies-org/paseo-archivadas"
  exit 1
fi
trunk=$(git -C "$checkout" remote show origin | sed -n 's/.*HEAD branch: //p')
git -C "$checkout" fetch origin "$trunk"
git -C "$checkout" checkout "$trunk"
git -C "$checkout" merge --ff-only "origin/$trunk"
paseo plugin reload "$id"
echo "desplegado $id desde $trunk@$(git -C "$checkout" rev-parse --short=12 HEAD)"

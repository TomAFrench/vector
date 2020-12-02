#!/usr/bin/env bash
set -e

stack="router"
root=$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." >/dev/null 2>&1 && pwd )
project=$(grep -m 1 '"name":' "$root/package.json" | cut -d '"' -f 4)

docker swarm init 2> /dev/null || true
docker network create --attachable --driver overlay "$project" 2> /dev/null || true

if grep -qs "$stack" <<<"$(docker stack ls --format '{{.Name}}')"
then echo "A $stack stack is already running" && exit 0;
fi

####################
# Load config

if [[ ! -f "$root/node.config.json" ]]
then cp "$root/ops/config/node.default.json" "$root/node.config.json"
fi
if [[ ! -f "$root/router.config.json" ]]
then cp "$root/ops/config/router.default.json" "$root/router.config.json"
fi

config=$(
  cat "$root/ops/config/node.default.json" "$root/ops/config/router.default.json" \
  | cat - "$root/node.config.json" "$root/router.config.json" \
  | jq -s '.[0] + .[1] + .[2] + .[3]'
)

function getConfig {
  value=$(echo "$config" | jq ".$1" | tr -d '"')
  if [[ "$value" == "null" ]]
  then echo ""
  else echo "$value"
  fi
}

database_url=$(getConfig databaseUrl)
messaging_url=$(getConfig messagingUrl)
mnemonic=$(getConfig mnemonic)
production=$(getConfig production)
public_port=$(getConfig port)

chain_providers=$(echo "$config" | jq '.chainProviders' | tr -d '\n\r ')
default_providers=$(jq '.chainProviders' "$root/ops/config/node.default.json" | tr -d '\n\r ')
if [[ "$chain_providers" == "$default_providers" ]]
then use_local_evms=true
else use_local_evms=false
fi

if [[ "$production" == "true" ]]
then
  # If we're on the prod branch then use the release semvar, otherwise use the commit hash
  if [[ "$(git rev-parse --abbrev-ref HEAD)" == "prod" || "${GITHUB_REF##*/}" == "prod" ]]
  then version=$(grep -m 1 '"version":' package.json | cut -d '"' -f 4)
  else version=$(git rev-parse HEAD | head -c 8)
  fi
else version="latest"
fi

common="networks:
      - '$project'
    logging:
      driver: 'json-file'
      options:
          max-size: '10m'"

####################
# Start up dependency stacks

if [[ "$use_local_evms" == "true" ]]
then bash "$root/ops/start-chains.sh"
fi
if [[ -z "$messaging_url" ]]
then bash "$root/ops/start-messaging.sh"
fi

echo
echo "Preparing to launch $stack stack w config:"
echo " - chain_providers=$chain_providers"
echo " - messaging_url=$messaging_url"
echo " - production=$production"
echo " - public_port=$public_port"
echo " - version=$version"

########################################
# Chain config

if [[ "$use_local_evms" == "true" ]]
then
  mnemonic_secret=""
  eth_mnemonic="${mnemonic:-candy maple cake sugar pudding cream honey rich smooth crumble sweet treat}"
  eth_mnemonic_file=""
  config=$(
    echo "$config" '{"chainAddresses":'"$(cat "$root/.chaindata/chain-addresses.json")"'}' \
    | jq -s '.[0] + .[1]'
  )

else
  echo "Connecting to external services: messaging=$messaging_url | chain_providers=$chain_providers"
  if [[ -n "$mnemonic" ]]
  then
    mnemonic_secret=""
    eth_mnemonic="$mnemonic"
    eth_mnemonic_file=""
  else
    mnemonic_secret="${project}_${stack}_mnemonic"
    eth_mnemonic=""
    eth_mnemonic_file="/run/secrets/$mnemonic_secret"
    if ! grep "$mnemonic_secret" <<<"$(docker secret ls --format '{{.Name}}')"
    then bash "$root/ops/save-secret.sh" "$mnemonic_secret"
    fi
  fi
fi

########################################
## Database config

if [[ "$production" == "true" && -z "$database_url" ]]
then
  echo "Fatal: An external database_url must be provided in prod-mode"
  exit 1
fi

########################################
## Node config

node_internal_port="8000"
node_public_port="${public_port:-8002}"
public_url="http://127.0.0.1:$node_public_port/ping"
if [[ $production == "true" ]]
then
  node_image_name="${project}_node:$version"
  node_image="image: '$node_image_name'
    ports:
      - '$node_public_port:$node_internal_port'"
else
  node_image_name="${project}_builder:$version";
  node_image="image: '$node_image_name'
    entrypoint: 'bash modules/server-node/ops/entry.sh'
    volumes:
      - '$root:/root'
    ports:
      - '$node_public_port:$node_internal_port'"
  echo "${stack}_node will be exposed on *:$node_public_port"
fi
bash "$root/ops/pull-images.sh" "$node_image_name" > /dev/null

# If we're using a secret to store our mnemonic, add this to the service config
if [[ -n "$mnemonic_secret" ]]
then
  node_image="$node_image
    secrets:
      - '$mnemonic_secret'"
fi

########################################
## Router config

router_internal_port="8000"
router_dev_port="9000"

if [[ $production == "true" ]]
then
  router_image_name="${project}_router:$version"
  router_image="image: '$router_image_name'"
else
  router_image_name="${project}_builder:$version";
  router_image="image: '$router_image_name'
    entrypoint: 'bash modules/router/ops/entry.sh'
    volumes:
      - '$root:/root'
    ports:
      - '$router_dev_port:$router_internal_port'"
  echo "${stack}_router will be exposed on *:$router_dev_port"
fi
bash "$root/ops/pull-images.sh" "$router_image_name" > /dev/null

####################
# Observability tools config

grafana_image="grafana/grafana:latest"
bash "$root/ops/pull-images.sh" "$grafana_image" > /dev/null

prometheus_image="prom/prometheus:latest"
bash "$root/ops/pull-images.sh" "$prometheus_image" > /dev/null

cadvisor_image="gcr.io/google-containers/cadvisor:latest"
bash "$root/ops/pull-images.sh" "$cadvisor_image" > /dev/null

prometheus_services="prometheus:
    image: $prometheus_image
    $common
    ports:
      - 9090:9090
    command:
      - --config.file=/etc/prometheus/prometheus.yml
    volumes:
      - $root/ops/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro

  cadvisor:
    $common
    image: $cadvisor_image
    ports:
      - 8081:8080
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:rw
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro"

grafana_service="grafana:
    image: '$grafana_image'
    $common
    networks:
      - '$project'
    ports:
      - '3008:3000'
    volumes:
      - '$root/ops/grafana/grafana:/etc/grafana'
      - '$root/ops/grafana/dashboards:/etc/dashboards'"

# TODO we probably want to remove observability from dev env once it's working
# bc these make indra take a log longer to wake up
observability_services="$prometheus_services

  $grafana_service"

####################
# Launch stack

# Add secrets to the stack config
if [[ -n "$mnemonic_secret" ]]
then
  stack_secrets="secrets:
  $mnemonic_secret:
    external: true"
else
  stack_secrets=""
fi

docker_compose=$root/.$stack.docker-compose.yml
rm -f "$docker_compose"
cat - > "$docker_compose" <<EOF
version: '3.4'

networks:
  $project:
    external: true

$stack_secrets

volumes:
  certs:

services:

  node:
    $common
    $node_image
    environment:
      VECTOR_CONFIG: '$(echo "$config" | tr -d '\n\r')'
      VECTOR_PROD: '$production'
      VECTOR_MNEMONIC: '$eth_mnemonic'
      VECTOR_MNEMONIC_FILE: '$eth_mnemonic_file'
      VECTOR_DATABASE_URL: '$database_url'

  router:
    $common
    $router_image
    environment:
      VECTOR_CONFIG: '$(echo "$config" | tr -d '\n\r')'
      VECTOR_PROD: '$production'
      VECTOR_NODE_URL: 'http://node:$node_internal_port'
      VECTOR_DATABASE_URL: '$database_url'

  $observability_services

EOF

docker stack deploy -c "$docker_compose" "$stack"

echo "The $stack stack has been deployed, waiting for $public_url to start responding.."
timeout=$(( $(date +%s) + 60 ))
while true
do
  res=$(curl -k -m 5 -s "$public_url" || true)
  if [[ -z "$res" || "$res" == "Waiting for node to wake up" ]]
  then
    if [[ "$(date +%s)" -gt "$timeout" ]]
    then echo "Timed out waiting for $public_url to respond.." && exit
    else sleep 2
    fi
  else echo "Good Morning!" && exit;
  fi
done

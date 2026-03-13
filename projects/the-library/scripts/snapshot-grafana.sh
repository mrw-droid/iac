#!/usr/bin/env bash
# Take a point-in-time snapshot of the Grafana PVC.
set -euo pipefail

NAMESPACE="monitoring"
PVC_NAME="grafana"
SNAPSHOT_CLASS="synology-csi-retain"
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
SNAP_NAME="grafana-snap-${TIMESTAMP}"

echo "Creating VolumeSnapshot ${SNAP_NAME} from PVC ${PVC_NAME} in ${NAMESPACE}..."

kubectl apply -f - <<EOF
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: ${SNAP_NAME}
  namespace: ${NAMESPACE}
spec:
  volumeSnapshotClassName: ${SNAPSHOT_CLASS}
  source:
    persistentVolumeClaimName: ${PVC_NAME}
EOF

echo "Waiting for snapshot to become ready..."
kubectl wait --for=jsonpath='{.status.readyToUse}=true' \
  volumesnapshot/"${SNAP_NAME}" -n "${NAMESPACE}" --timeout=120s

echo "Snapshot ${SNAP_NAME} is ready."
kubectl get volumesnapshot "${SNAP_NAME}" -n "${NAMESPACE}"

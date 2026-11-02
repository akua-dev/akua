package protocol

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/fluxcd/cli-utils/pkg/object"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// The ObjectKey pattern of cluster-agent.ts: `<namespace>_<name>_<group>_<kind>`.
var objectKeyPattern = regexp.MustCompile(`^[a-z0-9.-]*_[a-z0-9.:-]+_[a-z0-9.-]*_[A-Za-z0-9]+$`)

// KeyOf formats an object identifier as an ObjectKey. Unlike
// ObjMetadata.String it keeps colons in names (system:* RBAC objects), as
// the contract's pattern allows.
func KeyOf(id object.ObjMetadata) string {
	return strings.Join([]string{id.Namespace, id.Name, id.GroupKind.Group, id.GroupKind.Kind}, "_")
}

// ParseKey reads an ObjectKey back into an object identifier.
func ParseKey(key string) (object.ObjMetadata, error) {
	if len(key) > 600 || !objectKeyPattern.MatchString(key) {
		return object.ObjMetadata{}, fmt.Errorf("%q is not an object key", key)
	}
	parts := strings.Split(key, "_")
	return object.ObjMetadata{
		Namespace: parts[0],
		Name:      parts[1],
		GroupKind: schema.GroupKind{Group: parts[2], Kind: parts[3]},
	}, nil
}

// GroupVersionKind of an inventory entry.
func (e InventoryEntry) GroupVersionKind() (schema.GroupVersionKind, object.ObjMetadata, error) {
	id, err := ParseKey(e.Key)
	if err != nil {
		return schema.GroupVersionKind{}, id, err
	}
	return id.GroupKind.WithVersion(e.Version), id, nil
}

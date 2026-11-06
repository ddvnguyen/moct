package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestForkMigrationRenamesMatchFiles pins the renumber table to the tree: every
// new stem must be a migration that exists, every old stem must be gone, and the
// shift must be the documented +22 with the order preserved. A rename that names
// a stem no file ever had is a silent no-op on exactly the databases the hook
// exists for, so the table cannot be trusted unchecked.
func TestForkMigrationRenamesMatchFiles(t *testing.T) {
	t.Parallel()
	if len(forkMigrationRenames) == 0 {
		t.Fatal("no fork migration renames registered")
	}
	prevNew := 0
	for _, pair := range forkMigrationRenames {
		oldVersion, newVersion := pair[0], pair[1]
		if _, err := os.Stat(filepath.Join("..", "..", "migrations", newVersion+".up.sql")); err != nil {
			t.Errorf("new stem %q has no up migration: %v", newVersion, err)
		}
		if _, err := os.Stat(filepath.Join("..", "..", "migrations", oldVersion+".up.sql")); err == nil {
			t.Errorf("old stem %q still exists on disk; the rename is done in the tree", oldVersion)
		}
		oldNum, err := strconv.Atoi(strings.SplitN(oldVersion, "_", 2)[0])
		if err != nil {
			t.Fatalf("old stem %q is not numbered: %v", oldVersion, err)
		}
		newNum, err := strconv.Atoi(strings.SplitN(newVersion, "_", 2)[0])
		if err != nil {
			t.Fatalf("new stem %q is not numbered: %v", newVersion, err)
		}
		if newNum-oldNum != 22 {
			t.Errorf("%q -> %q is not the documented +22 shift", oldVersion, newVersion)
		}
		if newNum <= prevNew {
			t.Errorf("%q -> %q breaks the preserved order", oldVersion, newVersion)
		}
		if strings.TrimPrefix(oldVersion, strconv.Itoa(oldNum)+"_") != strings.TrimPrefix(newVersion, strconv.Itoa(newNum)+"_") {
			t.Errorf("%q -> %q changed the migration name, not just its number", oldVersion, newVersion)
		}
		prevNew = newNum
	}
}

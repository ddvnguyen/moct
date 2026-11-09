package middleware

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/internal/util"
)

type countingSlugDB struct {
	calls int32
}

func (c *countingSlugDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}
func (c *countingSlugDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	return nil, nil
}
func (c *countingSlugDB) QueryRow(_ context.Context, sql string, args ...interface{}) pgx.Row {
	atomic.AddInt32(&c.calls, 1)
	return fakeSlugRow{slug: args[0].(string)}
}

type fakeSlugRow struct {
	slug string
}

func (r fakeSlugRow) Scan(dest ...any) error {
	*dest[0].(*pgtype.UUID) = util.MustParseUUID("11111111-2222-3333-4444-555555555555")
	return nil
}

func TestResolveWorkspaceSlugCached(t *testing.T) {
	resetWorkspaceSlugCache()
	dbx := &countingSlugDB{}
	q := db.New(dbx)
	slug := "cached-slug-test"

	id1, err := ResolveWorkspaceSlug(context.Background(), q, slug)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	id2, err := ResolveWorkspaceSlug(context.Background(), q, slug)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if id1 != id2 {
		t.Fatalf("ids differ")
	}
	if got := atomic.LoadInt32(&dbx.calls); got != 1 {
		t.Fatalf("expected 1 DB call, got %d", got)
	}
}

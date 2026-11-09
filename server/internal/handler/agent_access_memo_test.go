package handler

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgconn"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type memoAgentDB struct {
	listCalls int32
}

func (m *memoAgentDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}
func (m *memoAgentDB) Query(_ context.Context, sql string, args ...interface{}) (pgx.Rows, error) {
	if strings.Contains(sql, "ListAllAgents") {
		atomic.AddInt32(&m.listCalls, 1)
	}
	return &emptyRows{}, nil
}
func (m *memoAgentDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	return nil
}

type emptyRows struct{}

func (e *emptyRows) Close()                                       {}
func (e *emptyRows) Err() error                                   { return nil }
func (e *emptyRows) CommandTag() pgconn.CommandTag                 { return pgconn.CommandTag{} }
func (e *emptyRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (e *emptyRows) Next() bool                                   { return false }
func (e *emptyRows) Scan(dest ...any) error                       { return nil }
func (e *emptyRows) Values() ([]any, error)                       { return nil, nil }
func (e *emptyRows) RawValues() [][]byte                          { return nil }
func (e *emptyRows) Conn() *pgx.Conn                              { return nil }
func (e *emptyRows) TypeMap() *pgtype.Map                            { return nil }

func TestAccessibleAgentIDsRunsOncePerRequest(t *testing.T) {
	mdb := &memoAgentDB{}
	q := db.New(mdb)
	h := &Handler{Queries: q}
	ctx := WithAgentAccessCache(context.Background())

	ws := "00000000-0000-0000-0000-000000000001"
	_, _ = h.accessibleAgentIDs(ctx, ws, "member", "user1", "owner")
	_, _ = h.accessibleAgentIDs(ctx, ws, "member", "user1", "owner")

	if got := atomic.LoadInt32(&mdb.listCalls); got != 1 {
		t.Fatalf("expected 1 ListAllAgents call, got %d", got)
	}

	// second request recomputes
	ctx2 := WithAgentAccessCache(context.Background())
	_, _ = h.accessibleAgentIDs(ctx2, ws, "member", "user1", "owner")
	if got := atomic.LoadInt32(&mdb.listCalls); got != 2 {
		t.Fatalf("expected 2 total ListAllAgents calls, got %d", got)
	}
}

// Command interop verifies discovery, corrections and RPC guards through the official Go SDK.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"reflect"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type credentials struct{}

func (credentials) RoundTrip(r *http.Request) (*http.Response, error) {
	req := r.Clone(r.Context())
	req.Header.Set("x-demo-key", "demo")
	req.Header.Set("x-scope", "read")
	return http.DefaultTransport.RoundTrip(req)
}

func check(ctx context.Context, target, runtime string) (err error) {
	stdio := target == "stdio"
	var t mcp.Transport
	if stdio {
		t = &mcp.CommandTransport{Command: exec.CommandContext(ctx, runtime, "server.ts", "stdio")}
	} else {
		t = &mcp.StreamableClientTransport{Endpoint: target, HTTPClient: &http.Client{Transport: credentials{}}, MaxRetries: -1}
	}
	c := mcp.NewClient(&mcp.Implementation{Name: "defuss-interop", Version: "1"}, nil)
	session, err := c.Connect(ctx, t, nil)
	if err != nil {
		return err
	}
	defer func() {
		if e := session.Close(); err == nil {
			err = e
		}
	}()
	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		return err
	}
	catalog := map[string]*mcp.Tool{}
	for _, t := range tools.Tools {
		catalog[t.Name] = t
	}
	direct, bridged := catalog["byteAdd"], catalog["math.add"]
	if direct == nil || bridged == nil || !reflect.DeepEqual(direct.InputSchema, bridged.InputSchema) || !reflect.DeepEqual(direct.OutputSchema, bridged.OutputSchema) {
		return fmt.Errorf("direct and RPC schemas differ or are missing")
	}
	args := map[string]any{"a": "AQI=", "b": "?"}
	call := func(name string) (*mcp.CallToolResult, error) {
		return session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	}
	failure, err := call(direct.Name)
	if err != nil {
		return err
	}
	var correction struct {
		Issues []struct {
			Path    string
			Keyword string
		}
	}
	wire, err := json.Marshal(failure.StructuredContent)
	if err != nil {
		return err
	}
	if err = json.Unmarshal(wire, &correction); err != nil {
		return err
	}
	if !failure.IsError || len(correction.Issues) != 1 || correction.Issues[0].Path != "/b" || correction.Issues[0].Keyword != "contentEncoding" {
		return fmt.Errorf("unexpected correction %s", wire)
	}
	args[correction.Issues[0].Path[1:]] = "AwQ="
	reply, err := call(direct.Name)
	if err != nil {
		return err
	}
	expected := map[string]any{"value": "BAY="}
	if reply.IsError || !reflect.DeepEqual(reply.StructuredContent, expected) {
		return fmt.Errorf("unexpected sum %+v", reply)
	}
	rpc, err := call(bridged.Name)
	if err != nil {
		return err
	}
	if rpc.IsError != stdio || (!stdio && !reflect.DeepEqual(rpc.StructuredContent, expected)) {
		return fmt.Errorf("unexpected guarded RPC result %+v", rpc)
	}
	return largePayloads(ctx, session, stdio)
}

// pattern returns the example server's bytes.pattern content: byte i is (i*37+11) mod 256.
func pattern(size int) []byte {
	out := make([]byte, size)
	for i := range out {
		out[i] = byte(i*37 + 11)
	}
	return out
}

// field decodes the base64 string at path in a structured result.
func field(content any, path ...string) []byte {
	for _, key := range path {
		object, _ := content.(map[string]any)
		content = object[key]
	}
	text, _ := content.(string)
	decoded, _ := base64.StdEncoding.DecodeString(text)
	return decoded
}

// largePayloads sends an upload just under the 4 MiB HTTP request limit and reads an 11 MiB download. Over stdio both
// are 6 MiB, under the SDK's 16 MiB line limit.
func largePayloads(ctx context.Context, session *mcp.ClientSession, stdio bool) error {
	const mib = 1 << 20
	upload, download := 3*mib-4096, 11*mib
	if stdio {
		upload, download = 6*mib, 6*mib
	}
	sent := pattern(upload)
	echo, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "bytes.echo", Arguments: map[string]any{"bytes": base64.StdEncoding.EncodeToString(sent)}})
	if err != nil {
		return err
	}
	if echo.IsError || !bytes.Equal(field(echo.StructuredContent, "bytes"), sent) {
		return fmt.Errorf("the %d-byte upload did not come back intact", upload)
	}
	got, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "bytes.pattern", Arguments: map[string]any{"size": download}})
	if err != nil {
		return err
	}
	if got.IsError || !bytes.Equal(field(got.StructuredContent, "value", "bytes"), pattern(download)) {
		return fmt.Errorf("the %d-byte download differs from the pattern", download)
	}
	return nil
}
func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: interop ENDPOINT|stdio RUNTIME")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := check(ctx, os.Args[1], os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// The browser and CLI in the SSH test rendezvous at a loopback DERP relay.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"

	"tailscale.com/derp/derpserver"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

func main() {
	relay := derpserver.New(key.NewNode(), logger.Discard)
	defer relay.Close()
	tls := httptest.NewTLSServer(derpserver.AddWebSocketSupport(relay, derpserver.Handler(relay)))
	defer tls.Close()
	node := &tailcfg.DERPNode{
		Name: "test1", RegionID: 1, HostName: "127.0.0.1", IPv4: "127.0.0.1", IPv6: "none",
		DERPPort: tls.Listener.Addr().(*net.TCPAddr).Port, STUNPort: -1, InsecureForTests: true,
	}
	region := &tailcfg.DERPRegion{RegionID: 1, RegionCode: "test", Nodes: []*tailcfg.DERPNode{node}}
	mux := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(&tailcfg.DERPMap{Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{1: region}})
	}))
	defer mux.Close()
	fmt.Println(mux.URL)
	io.Copy(io.Discard, os.Stdin)
}

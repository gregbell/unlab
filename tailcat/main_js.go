package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"io"
	"net"
	"sync"
	"syscall/js"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/logger"
)

type session struct {
	mu      sync.Mutex
	server  *tailcat.Server
	cancel  context.CancelFunc
	streams map[int]net.Conn
	next    int
	stopped bool
}

const maxStreams = 16

var active = &session{streams: make(map[int]net.Conn)}

func emit(event map[string]any) { js.Global().Call("postMessage", event) }
func (s *session) closeStream(id int) {
	s.mu.Lock()
	c := s.streams[id]
	delete(s.streams, id)
	s.mu.Unlock()
	if c != nil {
		c.Close()
		emit(map[string]any{"type": "close", "id": id})
	}
}
func (s *session) stop() {
	s.mu.Lock()
	s.stopped = true
	if s.cancel != nil {
		s.cancel()
	}
	server := s.server
	streams := s.streams
	s.streams = make(map[int]net.Conn)
	s.mu.Unlock()
	var draining sync.WaitGroup
	for _, conn := range streams {
		draining.Go(func() {
			defer conn.Close()
			// Keep the relay alive until the peer has seen EOF and closed its half.
			if writer, ok := conn.(interface{ CloseWrite() error }); ok {
				conn.SetDeadline(time.Now().Add(2 * time.Second))
				if writer.CloseWrite() == nil {
					io.Copy(io.Discard, conn)
				}
			}
		})
	}
	draining.Wait()
	if server != nil {
		server.Close()
	}
}
func hostKey() (string, error) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	var blob []byte
	for _, field := range [][]byte{[]byte("ssh-ed25519"), key} {
		blob = binary.BigEndian.AppendUint32(blob, uint32(len(field)))
		blob = append(blob, field...)
	}
	return base64.StdEncoding.EncodeToString(blob), nil
}
func (s *session) start() error {
	key, err := hostKey()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	server := &tailcat.Server{Logf: logger.Discard}
	server.OnTCP = func(port uint16) func(net.Conn) {
		if port != 22 {
			return nil
		}
		return func(c net.Conn) {
			s.mu.Lock()
			if s.stopped || len(s.streams) >= maxStreams {
				s.mu.Unlock()
				c.Close()
				return
			}
			s.next++
			id := s.next
			s.streams[id] = c
			s.mu.Unlock()
			emit(map[string]any{"type": "open", "id": id})
		}
	}
	s.mu.Lock()
	if s.stopped || s.cancel != nil {
		s.mu.Unlock()
		return context.Canceled
	}
	s.cancel = cancel
	s.mu.Unlock()
	if err := server.StartContext(ctx); err != nil {
		server.Close()
		s.stop()
		return err
	}
	s.mu.Lock()
	stopped := s.stopped
	if !stopped {
		s.server = server
	}
	s.mu.Unlock()
	if stopped {
		server.Close()
		return context.Canceled
	}
	emit(map[string]any{"type": "ready", "code": string(server.TailcatAddr()), "hostKey": key})
	return nil
}
func main() {
	js.Global().Set("tailcatMessage", js.FuncOf(func(_ js.Value, args []js.Value) any {
		msg := args[0]
		kind := msg.Get("type").String()
		if kind == "start" {
			go func() {
				if err := active.start(); err != nil {
					emit(map[string]any{"type": "error", "message": err.Error()})
				}
			}()
			return nil
		}
		if kind == "stop" {
			go func() {
				active.stop()
				emit(map[string]any{"type": "stopped"})
			}()
			return nil
		}
		id := msg.Get("id").Int()
		active.mu.Lock()
		c := active.streams[id]
		active.mu.Unlock()
		if c == nil {
			return nil
		}
		switch kind {
		case "close":
			go active.closeStream(id)
		case "read":
			go func() {
				b := make([]byte, 64<<10)
				n, err := c.Read(b)
				if n > 0 {
					data := js.Global().Get("Uint8Array").New(n)
					js.CopyBytesToJS(data, b[:n])
					emit(map[string]any{"type": "data", "id": id, "data": data})
					return
				}
				if err == io.EOF {
					emit(map[string]any{"type": "eof", "id": id})
					return
				}
				active.closeStream(id)
			}()
		case "write":
			data := msg.Get("data")
			b := make([]byte, data.Get("byteLength").Int())
			js.CopyBytesToGo(b, data)
			go func() {
				for len(b) > 0 {
					n, err := c.Write(b)
					if err != nil || n == 0 {
						active.closeStream(id)
						return
					}
					b = b[n:]
				}
				emit(map[string]any{"type": "written", "id": id})
			}()
		case "eof":
			go func() {
				if c, ok := c.(interface{ CloseWrite() error }); ok {
					c.CloseWrite()
				} else {
					active.closeStream(id)
				}
			}()
		}
		return nil
	}))
	js.Global().Call("tailcatLoaded")
	select {}
}

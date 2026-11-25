# Branch router with a data volume

A small branch office: one router between two subnets, a web server on one side and a client on the other.

| Machine  | Interface 1     | Interface 2    | Notes                                |
| -------- | --------------- | -------------- | ------------------------------------ |
| `router` | 172.20.10.1/24  | 172.20.20.1/24 | second disk, 1 GB, for `/srv/archive` |
| `web`    | 172.20.10.80/24 |                | nginx                                |
| `client` | 172.20.20.50/24 |                |                                      |

None of the machines needs the internet.

## Router

1. Put one partition on the second disk, format it as ext4 and mount it at `/srv/archive`.
2. Turn on IPv4 forwarding.
3. Write `/srv/archive/README.txt` with exactly this content:

   ```
   Archive volume for "branch-7"
   Owner: $OPS_TEAM   Path: C:\archive\new
   Grüße aus der Zentrale
   ```

## Hosts

`web` and `client` each reach the other subnet through the router.

On `web`, replace nginx's default site with:

```nginx
server {
    listen 80 default_server;
    location / {
        default_type text/plain;
        return 200 "branch-7 $remote_addr\n";
    }
}
```

and start nginx.

## Check

- From `client`, `ping` 172.20.10.80 through the router.
- From `client`, fetch http://172.20.10.80/. It answers `branch-7 172.20.20.50`.
- Reboot `router`. After it is back, mount the archive again, turn forwarding back on, and check that `README.txt` is byte for byte what you wrote. The ping works again.

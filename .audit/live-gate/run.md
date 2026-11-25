# The live run, 2026-11-25

A fresh agent (Claude Opus 5.5) was given the brief below and a command line client that could only list and call the
page's WebMCP tools, in a real Chromium on the built app. The harness clicked each approval as soon as it was shown.
That stands in for the person, so the run shows that approvals are the only clicks, and not that a person reads them.
The agent wrote several calls into one shell script at a time, which is why `calls.jsonl` has them close together.
Its session also held the host's usual preamble, which has nothing about unLAB's commands.

This is one run, by hand. `e2e/scenario.spec.ts` is what CI repeats.

## The brief

> You are connected to a virtual machine lab that runs in a browser tab. You reach it only through this command line
> client: `node lab.mjs list` (the lab's tools, with descriptions and input schemas), `node lab.mjs call <tool>
> <input.json>` (call one, with its JSON input in a file, "-" reads stdin). A person at the browser approves what the lab
> asks them to approve.
>
> Your task: set up the scenario described in `page.md` in that directory, and do all of its checks. Use only this client
> and that directory. Do not read any other file or directory on this computer, do not read the lab's source code, do not
> search the web, and do not use any browser tool. Everything you need about the lab is in its tools. Do not spawn
> subagents. If something about the lab confuses you or fails, work it out with the tools.

## What it ran

```sh
cd <work>; command ls -la; command cat page.md; node lab.mjs list
```

```sh
cd <work>
echo '{}' | node lab.mjs call machines_list -
echo '{"verb":"spawn"}' | node lab.mjs call lab_help -
echo '{"count":1,"image":"lab","name":"router","nics":2,"addr":"172.20.10.1/24,172.20.20.1/24","extraDisk":"1","gateway":"off"}' | node lab.mjs call machines_spawn -
echo '{"count":1,"image":"lab","name":"web","addr":"172.20.10.80/24","gateway":"off"}' | node lab.mjs call machines_spawn -
echo '{"count":1,"image":"lab","name":"client","addr":"172.20.20.50/24","gateway":"off"}' | node lab.mjs call machines_spawn -
echo '{}' | node lab.mjs call machines_list -
```

```sh
cd <work>
cat > ref.txt <<'EOF'
Archive volume for "branch-7"
Owner: $OPS_TEAM   Path: C:\archive\new
Grüße aus der Zentrale
EOF
cat > nginx.conf <<'EOF'
server {
    listen 80 default_server;
    location / {
        default_type text/plain;
        return 200 "branch-7 $remote_addr\n";
    }
}
EOF
node -e 'const fs=require("fs");const f=(m,p,s,o)=>fs.writeFileSync(o,JSON.stringify({machine:m,path:p,text:fs.readFileSync(s,"utf8")}));f("router","/srv/archive/README.txt","ref.txt","w1.json")'
sha256sum ref.txt nginx.conf; wc -c ref.txt
x(){ node -e 'console.log(JSON.stringify({targets:process.argv[1],command:process.argv[2]}))' "$1" "$2" | node lab.mjs call shell_exec -; }
x router 'lsblk; cat /etc/os-release | head -2; which sfdisk mkfs.ext4 mkfs sha256sum; ip -br a; ip r; cat /proc/sys/net/ipv4/ip_forward; mount | grep wd'
x router "echo ',,L' | sudo sfdisk /dev/wdc && sudo mkfs.ext4 -F /dev/wdc1 && sudo mkdir -p /srv/archive && sudo mount /dev/wdc1 /srv/archive && sudo sysctl -w net.ipv4.ip_forward=1; mount | grep archive; ls -l /dev/wdc*"
x web 'sudo ip route add 172.20.20.0/24 via 172.20.10.1; ip r; ls -lR /etc/nginx | head -60; grep -n include /etc/nginx/nginx.conf; cat /etc/nginx/http.d/default.conf; rc-service nginx status; ps | grep nginx'
x client 'sudo ip route add 172.20.10.0/24 via 172.20.20.1; ip r'
```

```sh
cd <work>
node -e 'const fs=require("fs");fs.writeFileSync("w2.json",JSON.stringify({machine:"web",path:"/etc/nginx/http.d/default.conf",text:fs.readFileSync("nginx.conf","utf8")}))'
x(){ node -e 'console.log(JSON.stringify({targets:process.argv[1],command:process.argv[2]}))' "$1" "$2" | node lab.mjs call shell_exec -; }
node lab.mjs call file_write w1.json
node lab.mjs call file_write w2.json
x router 'sha256sum /srv/archive/README.txt; wc -c /srv/archive/README.txt; df /srv/archive/README.txt; cat /srv/archive/README.txt'
x web 'sha256sum /etc/nginx/http.d/default.conf; sudo nginx -t && sudo nginx; pgrep -a nginx'
x client 'ping -c 3 172.20.10.80; traceroute -n 172.20.10.80; curl -sS -i http://172.20.10.80/'
echo '{"names":"router"}' | node lab.mjs call machines_reboot -
x router 'mount | grep archive; cat /proc/sys/net/ipv4/ip_forward; ls -la /srv/archive; ip -br a'
x router 'sudo mkdir -p /srv/archive; sudo mount /dev/wdc1 /srv/archive && sudo sysctl -w net.ipv4.ip_forward=1; mount | grep archive; sha256sum /srv/archive/README.txt; wc -c /srv/archive/README.txt; cat /srv/archive/README.txt'
x client 'ping -c 3 172.20.10.80; curl -sS http://172.20.10.80/'
```

```sh
cd <work>
x(){ node -e 'console.log(JSON.stringify({targets:process.argv[1],command:process.argv[2]}))' "$1" "$2" | node lab.mjs call shell_exec -; }
x client 'sudo ping -c 2 172.20.10.80; sudo traceroute -n 172.20.10.80'
echo '{"filter":"icmp 172.20.10.80","limit":8}' | node lab.mjs call capture_read -
```

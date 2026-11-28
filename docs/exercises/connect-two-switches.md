# Connect two switches

Can node1 still reach node2 if you move node2 to a different switch? Start at
the end of [Follow your first ping](../../README.md#follow-your-first-ping),
with both Alpine machines connected to `switch0` and the ping working.

1. **Move node2 to its own switch.** In the lab command bar at the top of the
   desktop, run each line separately. Press Enter after each command.

   ```text
   mkswitch lan
   plug node2 lan:1
   ```

   In **Topology**, node1 connects to **switch0** and node2 connects to **lan**.
   Both machines still have their original IP addresses.

2. **Test the gap.** In node1's terminal, repeat the ping from [Follow your first ping](../../README.md#follow-your-first-ping).

   ```sh
   ping -c 1 -W 2 node2
   ```

   Expect `100% packet loss`. Each machine has a cable to its switch, but there
   is no cable between the switches.

3. **Join the switches.** In the lab command bar, connect port 8 on each switch.

   ```text
   cable switch0:8 lan:8
   ```

   **Topology** now shows a cable between the switches. Run the same ping in
   node1's terminal. Expect `0% packet loss`.

4. **Follow the ping across the new cable.** Enter this filter in the command bar.

   ```text
   capture lan:8 icmp
   ```

   In **Packet inspector**, find `lan 8 → 1` on the echo request. It entered
   on port 8 from switch0 and left on port 1 toward node2. The echo reply
   shows the reverse path, `lan 1 → 8`.

## Put the lab back

In the command bar, move node2 back to its original port before removing the
switch you added. Run each line separately.

```text
plug node2 switch0:2
rmswitch lan
```

Select **Remove lan** to confirm. This also removes the cable between switches.
In **Topology**, both machines connect to **switch0** again.

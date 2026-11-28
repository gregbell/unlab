# Connect two switches

Can node1 still reach node2 if you move node2 to a different switch? Start at
the end of [Follow your first ping](../../README.md#follow-your-first-ping),
with both Alpine machines connected to `switch0` and the ping working.

1. **Move node2 to its own switch.** In **Rack manager**, open **Add** and
   choose **Add switch…**. Enter `lan` in **Switch name** and select **Add
   switch**. Select `node2` in the rack. Under **Network**, select **Patch**
   beside `eth0`. Choose `lan:1` in **Destination** and select **Connect**.

   In **Topology**, node1 connects to **switch0** and node2 connects to **lan**.
   Both machines still have their original IP addresses.

2. **Test the gap.** In node1's terminal, repeat the ping from
   [Follow your first ping](../../README.md#follow-your-first-ping).

   ```sh
   ping -c 1 -W 2 node2
   ```

   Expect `100% packet loss`. Each machine has a cable to its switch, but there
   is no cable between the switches.

3. **Join the switches.** Open the command bar at the top of the desktop. Enter
   the [cable command](../manual/networks.md#cable-join-switch-ports) to connect
   port 8 on each switch.

   ```text
   cable switch0:8 lan:8
   ```

   **Topology** now shows a cable between the switches. Run the same ping in
   node1's terminal. Expect `0% packet loss`.

4. **Follow the ping across the new cable.** From the lab menu, choose **Packet
   capture**, then **Packet inspector**. Type `lan:8 icmp` in the filter field.

   In **Packet inspector**, find `lan 8 → 1` on the echo request. It entered on
   port 8 from switch0 and left on port 1 toward node2. The echo reply shows the
   reverse path, `lan 1 → 8`.

## Put the lab back

In the rack, select `node2`. Use **Patch** beside `eth0` to move it back to
`switch0:2`. Both machines now connect to `switch0` in **Topology**.

Select `lan` in the rack, open **More actions**, and choose **Delete switch…**.
Select **Remove lan** to confirm. The switch and its cable disappear from
**Topology**.

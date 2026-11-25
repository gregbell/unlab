// A hidden page's timers are held to one a second, and then to one a minute. A
// worker's are not, so the page's clock for the link is here.

setInterval(() => self.postMessage(null), 1000);

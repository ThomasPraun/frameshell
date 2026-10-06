// Stand-in daemon entry for launcher tests: reports a startup error on stderr and exits 1 without listening.
process.stderr.write("cannot bind: test failure\n");
process.exit(1);

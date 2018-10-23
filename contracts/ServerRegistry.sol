pragma solidity ^0.4.19;

/// @title Registry for IN3-Nodes
contract ServerRegistry {

    event LogServerRegistered(string url, uint props, address owner, uint deposit);
    event LogServerUnregisterRequested(string url, address owner, address caller);
    event LogServerUnregisterCanceled(string url, address owner);
    event LogServerConvicted(string url, address owner);
    event LogServerRemoved(string url, address owner);

    struct Web3Server {
        string url;  // the url of the server
        address owner; // the owner, which is also the key to sign blockhashes
        uint deposit; // stored deposit
        uint props; // a list of properties-flags representing the capabilities of the server

        // unregister state
        uint128 unregisterTime; // earliest timestamp in to to call unregister
        uint128 unregisterDeposit; // Deposit for unregistering
        address unregisterCaller; // address of the caller requesting the unregister
    }
    
    Web3Server[] public servers;

    // index for unique url and owner
    mapping (address => bool) ownerIndex;
    mapping (bytes32 => bool) urlIndex;
    

    function totalServers() public constant returns (uint)  {
        return servers.length;
    }

    /// register a new Server with the sender as owner    
    function registerServer(string _url, uint _props) public payable {
        bytes32 urlHash = keccak256(_url);
        // make sure this url and also this owner was not registered before.
        require (!urlIndex[urlHash] && !ownerIndex[msg.sender]);

        // create new Webserver
        Web3Server memory m;
        m.url = _url;
        m.props = _props;
        m.owner = msg.sender;
        m.deposit = msg.value;
        servers.push(m);
        urlIndex[urlHash] = true;
        ownerIndex[msg.sender] = true;
        emit LogServerRegistered(_url, _props, msg.sender,msg.value);
    }

    /// updates a Server by adding the msg.value to the deposit and setting the props    
    function updateServer(uint _serverIndex, uint _props) public payable {
        Web3Server storage server = servers[_serverIndex];
        require(server.owner == msg.sender);

        if (msg.value>0) 
          server.deposit += msg.value;

        if (_props!=server.props)
          server.props = _props;

        emit LogServerRegistered(server.url, _props, msg.sender,server.deposit);
    }

    /// this should be called before unregistering a server.
    /// there are 2 use cases:
    /// a) the owner wants to stop offering this.
    ///    in this case he has to wait for one hour before actually removing the server.
    ///    This is needed in order to give others a chance to convict it in case this server signs wrong hashes
    /// b) anybody can request to remove a server because it has been inactive.
    ///    in this case he needs to pay a small deposit, which he will lose 
    //       if the owner become active again 
    //       or the caller will receive 20% of the deposit in case the owner does not react.
    function requestUnregisteringServer(uint _serverIndex) payable public {
        Web3Server storage server = servers[_serverIndex];
        // this can only be called if nobody requested it before
        require(server.unregisterCaller==address(0x0));

        if (server.unregisterCaller == server.owner) 
           server.unregisterTime = now + 1 hours;
        else {
            server.unregisterTime = now + 28 days; // 28 days are always good ;-) 
            // the requester needs to pay the unregisterDeposit in order to spam-protect the server
            require(msg.value == calcUnregisterDeposit(_serverIndex) );
            server.unregisterDeposit = msg.value;
        }
        server.unregisterCaller = msg.sender;
        emit LogServerUnregisterRequested(server.url, server.owner, msg.sender );
    }
    
    function confirmUnregisteringServer(uint _serverIndex) public {
        Web3Server storage server = servers[_serverIndex];
        // this can only be called if somebody requested it before
        require(server.unregisterCaller!=address(0x0) && server.unregisterTime < now);

        uint payBackOwner = server.deposit;
        if (server.unregisterCaller != server.owner) {
            payBackOwner -= server.deposit / 5;  // the owner will only receive 80% of his deposit back.
            server.unregisterCaller.transfer( server.unregisterDeposit + server.deposit - payBackOwner );
        }

        if (payBackOwner>0)
            server.owner.transfer( payBackOwner );

        removeServer(_serverIndex);
    }

    function cancelUnregisteringServer(uint _serverIndex) public {
        Web3Server storage server = servers[_serverIndex];

        // this can only be called by the owner and if somebody requested it before
        require(server.unregisterCaller!=address(0) &&  server.owner == msg.sender);

        // if this was requested by somebody who does not own this server,
        // the owner will get his deposit
        if (server.unregisterCaller != server.owner) 
            server.owner.transfer( server.unregisterDeposit );

        server.unregisterCaller = address(0);
        server.unregisterTime = 0;
        
        emit LogServerUnregisterCanceled(server.url, server.owner);
    }


    /// convicts a server that signed a wrong blockhash
    function convict(uint _serverIndex, bytes32 _blockhash, uint _blocknumber, uint8 _v, bytes32 _r, bytes32 _s) public {
        // if the blockhash is correct you cannot convict the server
        require(blockhash(_blocknumber) != _blockhash);

        // make sure the hash was signed by the owner of the server
        require(ecrecover(keccak256(_blockhash, _blocknumber), _v, _r, _s) == servers[_serverIndex].owner);

        // remove the deposit
        if (servers[_serverIndex].deposit>0) {
            uint payout = servers[_serverIndex].deposit/2;
            // send 50% to the caller of this function
            msg.sender.transfer(payout);

            // and burn the rest by sending it to the 0x0-address
            address(0).transfer(servers[_serverIndex].deposit-payout);
        }

        emit LogServerConvicted(servers[_serverIndex].url, servers[_serverIndex].owner );
        removeServer(_serverIndex);

    }
    
    // internal helpers
    
    function removeServer(uint _serverIndex) internal {
        emit LogServerRemoved(servers[_serverIndex].url, servers[_serverIndex].owner );
        urlIndex[keccak256(servers[_serverIndex].url)] = false;
        ownerIndex[servers[_serverIndex].owner ] = false;

        uint length = servers.length;
        Web3Server memory m = servers[length - 1];
        servers[_serverIndex] = m;
        servers.length--;
    }
    
    function calcUnregisterDeposit(uint _serverIndex) constant returns(uint128) {
        Web3Server storage server = servers[_serverIndex];
        return server.deposit / 50 + tx.gasprice * 50000; // cancelUnregisteringServer costs 22k gas, we took about twist that much due to volatility of gasPrices
    }
}